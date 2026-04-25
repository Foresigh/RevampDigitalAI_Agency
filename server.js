'use strict';

const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const { Pool }   = require('pg');
const fetch      = require('node-fetch');
const compression= require('compression');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const PDFDocument= require('pdfkit');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'revamp2024';
const SESSION_SECRET = process.env.SESSION_SECRET || 'revamp-secret-key-change-me';

// ── PostgreSQL ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── Settings helper ──
async function getSetting(key) {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
    return r.rows[0]?.value || null;
  } catch { return null; }
}

// ── Email helper — tries Resend first, falls back to SMTP ──
async function sendMail({ to, subject, html, attachments }) {
  // ── Resend REST API (preferred — just needs RESEND_API_KEY env var) ──
  const resendKey = process.env.RESEND_API_KEY || await getSetting('resend_api_key');
  if (resendKey) {
    const fromAddr = process.env.RESEND_FROM || await getSetting('resend_from') || 'Revamp Digital <hello@gorevamp.ai>';
    const payload = { from: fromAddr, to: Array.isArray(to) ? to : [to], subject, html };
    if (attachments && attachments.length) {
      payload.attachments = attachments.map(a => ({
        filename: a.filename,
        content: a.content.toString('base64'),
      }));
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || data.name || 'Resend API error');
    return true;
  }

  // ── SMTP fallback ──
  const host = process.env.SMTP_HOST || await getSetting('smtp_host');
  const port = parseInt(process.env.SMTP_PORT || await getSetting('smtp_port') || '587');
  const user = process.env.SMTP_USER || await getSetting('smtp_user');
  const pass = process.env.SMTP_PASS || await getSetting('smtp_pass');
  const from = process.env.SMTP_FROM || await getSetting('smtp_from') || `"Revamp Digital" <${user}>`;

  if (!host || !user || !pass) {
    throw new Error('No email provider configured. Add RESEND_API_KEY to Railway environment variables.');
  }
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  await transporter.sendMail({ from, to, subject, html, attachments });
  return true;
}

// ── PDF contract builder ──
function buildContractPdf(contract) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W      = doc.page.width;
    const H      = doc.page.height;
    const L      = 60;   // left margin
    const R      = W - 60; // right margin
    const CW     = W - 120; // content width
    const teal   = '#1F7A8C';
    const tealLt = '#3dd6f5';
    const dark   = '#0b1220';
    const black  = '#111111';
    const gray   = '#555555';
    const lgray  = '#888888';

    // ── Header bar ──
    doc.rect(0, 0, W, 88).fill(dark);
    doc.fontSize(22).fillColor('#ffffff').font('Helvetica-Bold')
      .text('REVAMP DIGITAL LLC', L, 22, { lineBreak: false });
    doc.fontSize(9).fillColor(tealLt).font('Helvetica')
      .text('SERVICE AGREEMENT', L, 52, { lineBreak: false });
    const dateStr = new Date(contract.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    doc.fontSize(8.5).fillColor('rgba(255,255,255,0.55)').font('Helvetica')
      .text(`REVAMP-${String(contract.id).padStart(4,'0')}-RV   ·   ${dateStr}`, L, 52, { align: 'right', width: CW, lineBreak: false });

    // ── Helpers ──
    let y = 108;

    const section = (title) => {
      y += 18;
      doc.fontSize(7.5).fillColor(teal).font('Helvetica-Bold')
        .text(title, L, y, { characterSpacing: 1.8, lineBreak: false });
      y += 13;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(teal).lineWidth(0.4).stroke();
      y += 8;
    };

    const row = (label, value, bold) => {
      doc.fontSize(9).fillColor(lgray).font('Helvetica-Bold')
        .text(label, L, y, { lineBreak: false, width: 110 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(black)
        .text(value || '—', L + 115, y, { width: CW - 115 });
      y = doc.y + 2;
    };

    const para = (text, color) => {
      doc.fontSize(9).fillColor(color || black).font('Helvetica')
        .text(text, L, y, { width: CW, lineGap: 1 });
      y = doc.y + 4;
    };

    // ── Client Information ──
    section('CLIENT INFORMATION');
    row('Name:', contract.client_name);
    row('Email:', contract.client_email);
    if (contract.start_date) {
      row('Start Date:', new Date(contract.start_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
    }

    // ── Services ──
    section('SERVICES INCLUDED');
    const serviceLines = (contract.services || '').split('\n').map(s => s.trim()).filter(Boolean);
    serviceLines.forEach((s, i) => {
      doc.fontSize(9).fillColor(black).font('Helvetica')
        .text(`${i + 1}.  ${s}`, L + 4, y, { width: CW - 4 });
      y = doc.y + 2;
    });

    // ── Payment ──
    y += 6;
    section('PAYMENT');
    // Total amount highlight box
    const boxY = y;
    doc.rect(L, boxY, CW, 34).fillColor('#f6fffc').stroke();
    doc.fontSize(8.5).fillColor(lgray).font('Helvetica')
      .text('TOTAL AGREED AMOUNT', L + 12, boxY + 8, { lineBreak: false });
    doc.fontSize(15).fillColor('#15803d').font('Helvetica-Bold')
      .text(`$${parseFloat(contract.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, L + 12, boxY + 18, { lineBreak: false });
    y = boxY + 44;

    if (contract.payment_schedule && contract.payment_schedule.trim()) {
      y += 4;
      doc.fontSize(8.5).fillColor(teal).font('Helvetica-Bold')
        .text('PAYMENT SCHEDULE', L, y, { lineBreak: false });
      y += 14;
      const schedLines = contract.payment_schedule.split('\n').map(s => s.trim()).filter(Boolean);
      schedLines.forEach((s, i) => {
        doc.fontSize(8.5).fillColor(black).font('Helvetica')
          .text(`${i + 1}.  ${s}`, L + 4, y, { width: CW - 4 });
        y = doc.y + 2;
      });
    }

    if (contract.notes && contract.notes.trim()) {
      y += 4;
      doc.fontSize(8.5).fillColor(lgray).font('Helvetica-Bold').text('NOTES', L, y, { lineBreak: false });
      y += 13;
      doc.fontSize(8.5).fillColor(gray).font('Helvetica').text(contract.notes, L + 4, y, { width: CW - 4 });
      y = doc.y + 4;
    }

    // ── Terms ──
    section('TERMS & CONDITIONS');
    const terms = [
      'Payment is due as per the agreed schedule above. Revamp Digital LLC reserves the right to pause work if payment is delayed beyond 7 days.',
      'The client grants Revamp Digital LLC permission to use completed work in its portfolio unless otherwise agreed in writing.',
      'Either party may terminate this agreement with 14 days written notice. Work completed to that point is billable.',
      'Revamp Digital LLC is not liable for any indirect or consequential damages arising from the use of delivered services.',
      'This agreement is governed by the laws of the State of Utah, United States.',
    ];
    terms.forEach((t, i) => {
      doc.fontSize(8.5).fillColor(gray).font('Helvetica')
        .text(`${i + 1}.   ${t}`, L, y, { width: CW, lineGap: 1.5 });
      y = doc.y + 4;
    });

    // ── Signature ──
    section('SIGNATURE');
    if (contract.signer_name) {
      // Signed state — green box
      const sigBoxY = y;
      doc.rect(L, sigBoxY, CW, 52).fillColor('#f0fdf4').stroke('#22c55e');
      doc.fontSize(11).fillColor('#15803d').font('Helvetica-Bold')
        .text('ELECTRONICALLY SIGNED', L + 14, sigBoxY + 8, { lineBreak: false });
      doc.fontSize(8.5).fillColor('#166534').font('Helvetica')
        .text(`Signed by: ${contract.signer_name}`, L + 14, sigBoxY + 24, { lineBreak: false });
      doc.fontSize(8).fillColor('#166534')
        .text(`Date: ${new Date(contract.signed_at).toLocaleString('en-US')}   ·   IP: ${contract.signer_ip || 'on record'}`,
          L + 14, sigBoxY + 36, { lineBreak: false });
      y = sigBoxY + 62;
      doc.fontSize(7.5).fillColor(lgray).font('Helvetica')
        .text('This electronic signature is legally binding under the U.S. ESIGN Act (15 U.S.C. § 7001).', L, y, { width: CW });
    } else {
      // Unsigned — blank signature lines
      const lineY1 = y + 36;
      const lineY2 = y + 60;
      doc.fontSize(8.5).fillColor(lgray).font('Helvetica').text('Client Signature', L, y);
      doc.moveTo(L, lineY1).lineTo(L + 220, lineY1).strokeColor('#aaaaaa').lineWidth(0.8).stroke();
      doc.fontSize(8).fillColor(lgray).text('Date', L + 240, y);
      doc.moveTo(L + 240, lineY1).lineTo(R, lineY1).strokeColor('#aaaaaa').lineWidth(0.8).stroke();
      y = lineY1 + 8;
      doc.fontSize(7.5).fillColor(lgray).font('Helvetica')
        .text('By signing, I agree to all terms above. This constitutes a legally binding agreement.', L, y, { width: CW });
    }

    // ── Footer ──
    doc.rect(0, H - 36, W, 36).fill(dark);
    doc.fontSize(7.5).fillColor('rgba(255,255,255,0.4)').font('Helvetica')
      .text('Revamp Digital LLC  ·  hello@gorevamp.ai  ·  (385) 253-2318  ·  gorevamp.ai  ·  Utah, United States',
        L, H - 22, { align: 'center', width: CW, lineBreak: false });

    doc.end();
  });
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id          SERIAL PRIMARY KEY,
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      owner_name  TEXT NOT NULL,
      business_name TEXT,
      business_type TEXT,
      email       TEXT NOT NULL,
      phone       TEXT,
      current_website TEXT,
      inspire_url TEXT,
      goals       TEXT,
      status      TEXT DEFAULT 'new',
      notes       TEXT DEFAULT ''
    )
  `);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS inspire_url TEXT DEFAULT ''`);

  // Audits table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audits (
      id           SERIAL PRIMARY KEY,
      audited_at   TIMESTAMPTZ DEFAULT NOW(),
      url          TEXT NOT NULL,
      score_perf   INT,
      score_seo    INT,
      score_mobile INT,
      score_desktop INT,
      result_json  JSONB
    )
  `);
  await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS result_json JSONB`);
  await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS score_accessibility INT`);
  await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS score_best_practices INT`);

  // Audit PDF downloads — tracks who requested a report
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_downloads (
      id           SERIAL PRIMARY KEY,
      downloaded_at TIMESTAMPTZ DEFAULT NOW(),
      email        TEXT NOT NULL,
      url          TEXT,
      ip           TEXT,
      city         TEXT,
      region       TEXT,
      country      TEXT,
      user_agent   TEXT
    )
  `);
  await pool.query(`ALTER TABLE audit_downloads ADD COLUMN IF NOT EXISTS ip TEXT`);
  await pool.query(`ALTER TABLE audit_downloads ADD COLUMN IF NOT EXISTS city TEXT`);
  await pool.query(`ALTER TABLE audit_downloads ADD COLUMN IF NOT EXISTS region TEXT`);
  await pool.query(`ALTER TABLE audit_downloads ADD COLUMN IF NOT EXISTS country TEXT`);
  await pool.query(`ALTER TABLE audit_downloads ADD COLUMN IF NOT EXISTS user_agent TEXT`);

  // Portfolio projects
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id           SERIAL PRIMARY KEY,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      client_name  TEXT NOT NULL,
      industry     TEXT,
      website_url  TEXT,
      before_url   TEXT,
      project_type TEXT DEFAULT 'built',
      description  TEXT,
      services     TEXT,
      featured     BOOLEAN DEFAULT false,
      sort_order   INTEGER DEFAULT 0,
      active       BOOLEAN DEFAULT true
    )
  `);
  await pool.query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS project_type TEXT DEFAULT 'built'`);
  await pool.query(`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS before_url TEXT`);

  // Settings key-value store
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Payment orders — populated by Stripe webhook
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                  SERIAL PRIMARY KEY,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      stripe_session_id   TEXT UNIQUE,
      customer_email      TEXT,
      plan_name           TEXT,
      amount_cents        INTEGER DEFAULT 0,
      currency            TEXT DEFAULT 'usd',
      status              TEXT DEFAULT 'pending'
    )
  `);

  // Service contracts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contracts (
      id               SERIAL PRIMARY KEY,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      token            TEXT UNIQUE NOT NULL,
      client_name      TEXT NOT NULL,
      client_email     TEXT NOT NULL,
      services         TEXT,
      amount           NUMERIC(10,2) DEFAULT 0,
      payment_schedule TEXT,
      start_date       DATE,
      notes            TEXT,
      status           TEXT DEFAULT 'draft',
      sent_at          TIMESTAMPTZ,
      signed_at        TIMESTAMPTZ,
      signer_name      TEXT,
      signer_ip        TEXT,
      expires_at       TIMESTAMPTZ
    )
  `);
  await pool.query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS payment_schedule TEXT`);

  console.log('[db] tables ready');
}

app.use(compression());

// ── Stripe webhook — raw body required, must come BEFORE express.json() ──
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || await getSetting('stripe_webhook_secret');
  if (!webhookSecret) return res.status(400).json({ error: 'Webhook secret not configured' });

  let event;
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY || await getSetting('stripe_secret_key');
    const stripe = Stripe(stripeKey);
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const planName = session.metadata?.plan || '';
    const email = session.customer_details?.email || session.customer_email || '';
    try {
      await pool.query(
        `INSERT INTO orders (stripe_session_id, customer_email, plan_name, amount_cents, currency, status)
         VALUES ($1,$2,$3,$4,$5,'paid')
         ON CONFLICT (stripe_session_id) DO UPDATE SET status='paid', customer_email=EXCLUDED.customer_email`,
        [session.id, email, planName, session.amount_total || 0, session.currency || 'usd']
      );
      console.log(`[order] paid — ${email} — ${planName} — $${((session.amount_total||0)/100).toFixed(2)}`);
    } catch (e) { console.error('[order save error]', e.message); }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/admin/login');
}

// ── Login page ──
app.get('/admin/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/admin');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Admin Login | Revamp Digital</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;background:#05080f;display:flex;align-items:center;justify-content:center;font-family:'Poppins',sans-serif}
    .login-card{background:linear-gradient(135deg,rgba(31,122,140,0.12),rgba(255,255,255,0.02));border:1px solid rgba(61,214,245,0.15);border-radius:20px;padding:48px 40px;width:100%;max-width:400px;position:relative;overflow:hidden}
    .login-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(61,214,245,0.5),transparent)}
    .logo{text-align:center;margin-bottom:32px}
    .logo h1{font-size:1.4rem;color:#e8f0fe;font-weight:700}
    .logo small{font-size:0.75rem;color:#3dd6f5;letter-spacing:1px;text-transform:uppercase}
    label{display:block;font-size:0.82rem;color:rgba(255,255,255,0.5);margin-bottom:6px;letter-spacing:0.5px}
    input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(61,214,245,0.15);border-radius:10px;padding:12px 16px;color:#e8f0fe;font-size:0.95rem;font-family:inherit;outline:none;transition:border 0.2s}
    input:focus{border-color:rgba(61,214,245,0.5)}
    .form-group{margin-bottom:20px}
    .btn{width:100%;background:linear-gradient(135deg,#1F7A8C,#15606e);border:none;border-radius:10px;padding:13px;color:#fff;font-size:0.95rem;font-weight:600;font-family:inherit;cursor:pointer;margin-top:8px;transition:opacity 0.2s}
    .btn:hover{opacity:0.88}
    .error{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 14px;color:#f87171;font-size:0.84rem;margin-bottom:20px}
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo">
      <h1>Revamp Digital</h1>
      <small>Admin Dashboard</small>
    </div>
    ${req.query.error ? '<div class="error">Incorrect password. Try again.</div>' : ''}
    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label>Password</label>
        <input type="password" name="password" placeholder="Enter admin password" autofocus required/>
      </div>
      <button type="submit" class="btn">Sign In</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ── API: receive form submission ──
app.post('/api/submit', async (req, res) => {
  const b = req.body;
  const owner_name = b.owner_name || b.name || '';
  const email      = b.email || '';
  if (!owner_name || !email) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const result = await pool.query(
      `INSERT INTO leads (owner_name, business_name, business_type, email, phone, current_website, inspire_url, goals)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        owner_name,
        b.business_name || b.business || '',
        b.business_type || b.reason  || '',
        email,
        b.phone           || '',
        b.current_website || '',
        b.inspire_url     || '',
        b.goals || b.message || ''
      ]
    );
    console.log(`[lead saved] id=${result.rows[0].id} ${owner_name} <${email}>`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[lead save error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: website audit via Google PageSpeed ──
function scoreColor(s) {
  return s >= 90 ? '#4ade80' : s >= 50 ? '#f5c842' : '#ef4444';
}

function parseAudit(mobile, desktop) {
  const ma = mobile.lighthouseResult?.audits || {};
  const mc = mobile.lighthouseResult?.categories || {};
  const dc = desktop.lighthouseResult?.categories || {};

  const perf          = Math.round((mc.performance?.score          || 0) * 100);
  const seo           = Math.round((mc.seo?.score                  || 0) * 100);
  const accessibility = Math.round((mc.accessibility?.score        || 0) * 100);
  const bestPractices = Math.round((mc['best-practices']?.score    || 0) * 100);
  const desktopPerf   = Math.round((dc.performance?.score          || 0) * 100);

  const issues = [], wins = [], mobileIssues = [], mobileWins = [];

  const check = (key, failMsg, winMsg, threshold = 0.9) => {
    const a = ma[key];
    if (!a || a.score === null || a.score === undefined) return;
    if (a.score < threshold) issues.push({ text: failMsg.replace('{val}', a.displayValue || ''), severity: a.score < 0.5 ? 'high' : 'medium' });
    else if (winMsg) wins.push(winMsg);
  };

  // ── Mobile-specific checks ──
  const mobileChecks = [
    { key: 'viewport',       pass: 'Mobile viewport is correctly configured', fail: 'Site is not configured for mobile — it will look broken on phones', weight: 30 },
    { key: 'font-size',      pass: 'Text is legible on mobile without zooming', fail: 'Text is too small to read on mobile without zooming in', weight: 20 },
    { key: 'tap-targets',    pass: 'Buttons and links are easy to tap on mobile', fail: 'Buttons and links are too small on mobile — visitors struggle to tap them', weight: 25 },
    { key: 'content-width',  pass: 'Page content fits the screen correctly', fail: 'Content is wider than the screen — visitors must scroll sideways on mobile', weight: 15 },
    { key: 'uses-responsive-images', pass: 'Images are sized appropriately for mobile', fail: 'Images are not sized for mobile — wasting data and slowing load time', weight: 10 },
  ];
  let mobileTotal = 0, mobilePossible = 0;
  mobileChecks.forEach(({ key, pass, fail, weight }) => {
    const a = ma[key];
    if (!a || a.score === null || a.score === undefined) return;
    mobilePossible += weight;
    if (a.score >= 0.9) { mobileTotal += weight; mobileWins.push(pass); }
    else mobileIssues.push({ text: fail, severity: a.score < 0.5 ? 'high' : 'medium' });
  });
  // Also factor in mobile perf score
  const mobilePerfScore = Math.round((mc.performance?.score || 0) * 100);
  mobilePossible += 30;
  mobileTotal += Math.round((mobilePerfScore / 100) * 30);
  const mobileFriendly = mobilePossible > 0 ? Math.round((mobileTotal / mobilePossible) * 100) : 50;

  const lcp = ma['largest-contentful-paint'];
  if (lcp && lcp.score !== null) {
    if (lcp.score < 0.9) issues.push({ text: `Your page takes ${lcp.displayValue} to load — visitors leave after 3 seconds`, severity: lcp.score < 0.5 ? 'high' : 'medium' });
    else wins.push('Page loads quickly');
  }

  check('meta-description',
    "No meta description — Google can't summarize your page in search results",
    'Meta description is present', 1);
  check('document-title',
    "Page is missing a title tag — search engines won't know what your site is about",
    'Page title is set', 1);
  check('uses-optimized-images',
    'Images are not compressed — slowing your site and hurting search ranking',
    'Images are optimized');
  check('is-on-https',
    'Site is not secure (no HTTPS) — browsers warn visitors away',
    'HTTPS is enabled');
  check('image-alt',
    'Images have no alt text — hurts SEO and accessibility',
    null, 1);
  check('total-blocking-time',
    'Page is slow to respond to clicks — frustrating for visitors',
    null);
  check('robots-txt',
    'No robots.txt — search engines may have trouble crawling your site',
    'robots.txt is present', 1);

  // ── Specific, data-driven recommendations ──
  const lcpVal  = ma['largest-contentful-paint']?.displayValue || null;
  const tbtVal  = ma['total-blocking-time']?.displayValue || null;
  const clsVal  = ma['cumulative-layout-shift']?.displayValue || null;
  const lcpScore= ma['largest-contentful-paint']?.score ?? 1;
  const tbtScore= ma['total-blocking-time']?.score ?? 1;
  const noMeta  = (ma['meta-description']?.score ?? 1) < 1;
  const noTitle = (ma['document-title']?.score ?? 1) < 1;
  const noHttps = (ma['is-on-https']?.score ?? 1) < 1;
  const imgUnopt= (ma['uses-optimized-images']?.score ?? 1) < 0.9;
  const noAlt   = (ma['image-alt']?.score ?? 1) < 1;
  const hasViewport = (ma['viewport']?.score ?? 1) >= 0.9;
  const smallFont   = (ma['font-size']?.score ?? 1) < 0.9;
  const badTap      = (ma['tap-targets']?.score ?? 1) < 0.9;

  const recs = [];

  if (noHttps) {
    recs.push({ priority: 1, title: 'Switch to HTTPS immediately', detail: 'Your site is running over HTTP, which means browsers display a "Not Secure" warning to every visitor. Google also penalizes non-HTTPS sites in search rankings. This single fix removes a trust barrier that is actively driving visitors away.' });
  }
  if (lcpScore < 0.5 && lcpVal) {
    recs.push({ priority: 2, title: `Fix your page load time (currently ${lcpVal})`, detail: `Your Largest Contentful Paint is ${lcpVal} — the industry standard is under 2.5 seconds. At this speed, over 50% of mobile visitors leave before your page finishes loading. Compressing images, removing unused scripts, and enabling caching could cut this in half.` });
  } else if (lcpScore < 0.9 && lcpVal) {
    recs.push({ priority: 3, title: `Improve page load speed (currently ${lcpVal})`, detail: `Your Largest Contentful Paint is ${lcpVal}. Google targets under 2.5 seconds for a good user experience. Optimizing your largest images and deferring non-critical scripts would push you into the green zone.` });
  }
  if (tbtScore < 0.5 && tbtVal) {
    recs.push({ priority: 2, title: `Reduce page blocking time (currently ${tbtVal})`, detail: `Your Total Blocking Time of ${tbtVal} means the page appears frozen for visitors while scripts load. They click buttons and nothing happens. Breaking up long JavaScript tasks is the fix — this directly improves your conversion rate.` });
  }
  if (!hasViewport || smallFont || badTap) {
    const mobileProblems = [];
    if (!hasViewport) mobileProblems.push('no mobile viewport configured');
    if (smallFont) mobileProblems.push('text too small to read without zooming');
    if (badTap) mobileProblems.push('buttons too small to tap accurately');
    recs.push({ priority: 2, title: 'Fix critical mobile usability issues', detail: `Your site has ${mobileProblems.join(', ')}. With over 70% of searches happening on phones, these issues are causing most of your mobile visitors to leave immediately and call a competitor instead.` });
  }
  if (noMeta && noTitle) {
    recs.push({ priority: 3, title: 'Add a page title and meta description', detail: "Your page has no title tag and no meta description. These are the two most basic SEO elements — without them Google doesn't know what your page is about and won't rank it. Adding them takes under an hour and can meaningfully improve your search visibility within weeks." });
  } else if (noMeta) {
    recs.push({ priority: 3, title: 'Add a meta description for Google', detail: "Your page is missing a meta description — the short summary Google shows under your link in search results. Without it, Google generates one automatically, often poorly. A well-written description increases click-through rates by 5–10%." });
  }
  if (imgUnopt) {
    recs.push({ priority: 3, title: 'Compress and modernize your images', detail: 'Your images are not optimized. Switching to WebP format and compressing images typically reduces page size by 30–60%, directly improving your load time score and reducing mobile data usage for your visitors.' });
  }
  if (noAlt) {
    recs.push({ priority: 4, title: 'Add alt text to all images', detail: 'Images on your site are missing alt text. This hurts both accessibility (screen readers cannot describe your images) and SEO (Google cannot index your image content). Each image should have a concise description of what it shows.' });
  }
  if (accessibility < 70) {
    recs.push({ priority: 4, title: `Fix accessibility issues (score: ${accessibility}/100)`, detail: 'Your accessibility score is below 70. Poor accessibility affects users with disabilities and is increasingly used by Google as a quality signal. Common quick wins include fixing color contrast ratios and adding labels to form inputs.' });
  }

  // Sort by priority and always return at least one
  recs.sort((a, b) => a.priority - b.priority);
  if (!recs.length) {
    recs.push({ priority: 5, title: 'Add a clear call-to-action above the fold', detail: `Your technical scores are solid. The next growth lever is conversion rate optimization. Most visitors decide to stay or leave within 5 seconds — adding a prominent phone number, a single clear headline, and one call-to-action button above the fold typically increases contact form submissions by 20–40%.` });
  }

  const suggestion = recs[0].detail; // keep backward compat for audit page

  // ── Core Web Vitals metrics ──
  const metricVal = key => ma[key]?.displayValue || null;
  const metricScore = key => ma[key]?.score ?? null;
  const metrics = {
    fcp:   { label: 'First Contentful Paint', value: metricVal('first-contentful-paint'),   score: metricScore('first-contentful-paint') },
    lcp:   { label: 'Largest Contentful Paint', value: metricVal('largest-contentful-paint'), score: metricScore('largest-contentful-paint') },
    tbt:   { label: 'Total Blocking Time',    value: metricVal('total-blocking-time'),       score: metricScore('total-blocking-time') },
    cls:   { label: 'Cumulative Layout Shift', value: metricVal('cumulative-layout-shift'),  score: metricScore('cumulative-layout-shift') },
    si:    { label: 'Speed Index',             value: metricVal('speed-index'),               score: metricScore('speed-index') },
    tti:   { label: 'Time to Interactive',     value: metricVal('interactive'),               score: metricScore('interactive') },
  };

  // ── Accessibility diagnostics ──
  const a11yAudits = mobile.lighthouseResult?.categories?.accessibility?.auditRefs || [];
  const a11yIssues = a11yAudits
    .filter(ref => ref.weight > 0)
    .map(ref => ma[ref.id])
    .filter(a => a && a.score !== null && a.score < 1 && a.score !== undefined)
    .slice(0, 5)
    .map(a => ({ text: a.title, severity: a.score < 0.5 ? 'high' : 'medium' }));

  // ── Best practices diagnostics ──
  const bpAudits = mobile.lighthouseResult?.categories?.['best-practices']?.auditRefs || [];
  const bpIssues = bpAudits
    .filter(ref => ref.weight > 0)
    .map(ref => ma[ref.id])
    .filter(a => a && a.score !== null && a.score < 1 && a.score !== undefined)
    .slice(0, 5)
    .map(a => ({ text: a.title, severity: a.score < 0.5 ? 'high' : 'medium' }));

  return {
    scores: { performance: perf, seo, accessibility, bestPractices, desktop: desktopPerf, mobileFriendly },
    metrics,
    issues: issues.slice(0, 5),
    wins:   wins.slice(0, 3),
    mobileIssues: mobileIssues.slice(0, 4),
    mobileWins:   mobileWins.slice(0, 3),
    a11yIssues,
    bpIssues,
    recommendations: recs.slice(0, 4),
    suggestion
  };
}

app.get('/api/audit', async (req, res) => {
  let { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    const base = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
    const cats = 'category=performance&category=seo&category=accessibility&category=best-practices';
    const key  = process.env.PAGESPEED_API_KEY ? `&key=${process.env.PAGESPEED_API_KEY}` : '';
    const [mr, dr] = await Promise.all([
      fetch(`${base}?url=${encodeURIComponent(url)}&strategy=mobile&${cats}${key}`),
      fetch(`${base}?url=${encodeURIComponent(url)}&strategy=desktop&${cats}${key}`)
    ]);
    const mobile = await mr.json();
    const desktop = await dr.json();
    if (mobile.error) throw new Error(mobile.error.message || 'Could not analyze that URL');
    const result = parseAudit(mobile, desktop);
    // Save to DB and return audit ID
    let auditId = null;
    try {
      const ins = await pool.query(
        `INSERT INTO audits (url, score_perf, score_seo, score_mobile, score_desktop, score_accessibility, score_best_practices, result_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [url, result.scores.performance, result.scores.seo, result.scores.mobileFriendly, result.scores.desktop, result.scores.accessibility, result.scores.bestPractices, JSON.stringify({ url, ...result })]
      );
      auditId = ins.rows[0].id;
    } catch (e) { console.error('[audit save error]', e.message); }
    res.json({ url, auditId, ...result });
  } catch (err) {
    console.error('[audit error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: get all leads (admin only) ──
app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, submitted_at AS "submittedAt", owner_name, business_name,
              business_type, email, phone, current_website, inspire_url, goals, status, notes
       FROM leads ORDER BY submitted_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: manually add a lead (admin only) ──
app.post('/api/leads/manual', requireAuth, async (req, res) => {
  const b = req.body;
  const owner_name = (b.owner_name || '').trim();
  const email      = (b.email || '').trim();
  if (!owner_name || !email) return res.status(400).json({ error: 'Name and email are required' });
  try {
    const result = await pool.query(
      `INSERT INTO leads (owner_name, business_name, business_type, email, phone, current_website, goals, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        owner_name,
        b.business_name || '',
        b.business_type || '',
        email,
        b.phone         || '',
        b.current_website || '',
        b.goals         || '',
        b.status        || 'new'
      ]
    );
    console.log(`[lead manual] id=${result.rows[0].id} ${owner_name} <${email}>`);
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[manual lead error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: update lead status/notes ──
app.patch('/api/leads/:id', requireAuth, async (req, res) => {
  const { status, notes } = req.body;
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE leads SET status = COALESCE($1, status), notes = COALESCE($2, notes) WHERE id = $3`,
      [status || null, notes !== undefined ? notes : null, id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: get all audits (admin only) ──
app.get('/api/audits', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, audited_at AS "auditedAt", url, score_perf, score_seo, score_mobile, score_desktop, score_accessibility, score_best_practices
       FROM audits ORDER BY audited_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: save email before PDF download ──
app.post('/api/audit-email', async (req, res) => {
  const { email, url } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  // Get IP (Railway puts real IP in X-Forwarded-For)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';

  // Geolocation via ip-api.com (free, no key, 45 req/min)
  let city = '', region = '', country = '';
  try {
    if (ip && !ip.startsWith('127.') && !ip.startsWith('::')) {
      const geo = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country`);
      const gd  = await geo.json();
      if (gd.city)       city    = gd.city;
      if (gd.regionName) region  = gd.regionName;
      if (gd.country)    country = gd.country;
    }
  } catch (e) { /* non-critical */ }

  try {
    await pool.query(
      `INSERT INTO audit_downloads (email, url, ip, city, region, country, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [email, url || '', ip, city, region, country, ua]
    );
    console.log(`[audit-download] ${email} from ${city}, ${region} | ${url}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[audit-email error]', e.message);
    res.status(500).json({ error: 'Could not save email' });
  }
});

// ── API: get audit download leads (admin only) ──
app.get('/api/audit-leads', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, downloaded_at AS "downloadedAt", email, url, ip, city, region, country, user_agent AS "userAgent"
       FROM audit_downloads ORDER BY downloaded_at DESC LIMIT 500`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: get stored audit result by ID ──
app.get('/api/audit-data/:id', async (req, res) => {
  try {
    const r = await pool.query(`SELECT result_json FROM audits WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0].result_json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Audit report page (print/PDF) ──
app.get('/audit-report/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'audit-report.html'));
});

// ── API: portfolio (public) ──
app.get('/api/portfolio', async (req, res) => {
  const showAll = req.query.all === '1' && req.session?.admin;
  try {
    const r = await pool.query(
      `SELECT id, client_name, industry, website_url, before_url, project_type, description, services, featured, sort_order, active
       FROM portfolio ${showAll ? '' : 'WHERE active = true '}ORDER BY featured DESC, sort_order ASC, created_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: portfolio CRUD (admin) ──
app.post('/api/portfolio', requireAuth, async (req, res) => {
  const { client_name, industry, website_url, before_url, project_type, description, services, featured, sort_order } = req.body;
  if (!client_name) return res.status(400).json({ error: 'Client name required' });
  try {
    const r = await pool.query(
      `INSERT INTO portfolio (client_name, industry, website_url, before_url, project_type, description, services, featured, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [client_name, industry||'', website_url||'', before_url||'', project_type||'built', description||'', services||'', !!featured, sort_order||0]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/portfolio/:id', requireAuth, async (req, res) => {
  const { client_name, industry, website_url, before_url, project_type, description, services, featured, sort_order, active } = req.body;
  try {
    await pool.query(
      `UPDATE portfolio SET
        client_name  = COALESCE($1, client_name),
        industry     = COALESCE($2, industry),
        website_url  = COALESCE($3, website_url),
        before_url   = COALESCE($4, before_url),
        project_type = COALESCE($5, project_type),
        description  = COALESCE($6, description),
        services     = COALESCE($7, services),
        featured     = COALESCE($8, featured),
        sort_order   = COALESCE($9, sort_order),
        active       = COALESCE($10, active)
       WHERE id = $11`,
      [client_name||null, industry||null, website_url||null, before_url||null,
       project_type||null, description||null, services||null, featured??null,
       sort_order??null, active??null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/portfolio/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM portfolio WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: payment config (public — only URLs, no secrets) ──
app.get('/api/payment-config', async (req, res) => {
  try {
    const [r1, r2, r3, enabled] = await Promise.all([
      getSetting('plan_website_revamp_url'),
      getSetting('plan_growth_monthly_url'),
      getSetting('plan_premium_monthly_url'),
      getSetting('payments_enabled'),
    ]);
    res.json({
      enabled: enabled !== 'false',
      plans: {
        website_revamp:  r1 || '',
        growth_monthly:  r2 || '',
        premium_monthly: r3 || '',
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: get settings (admin) ──
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT key, value FROM settings ORDER BY key`);
    const obj = {};
    r.rows.forEach(row => { obj[row.key] = row.value; });
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: save settings (admin) ──
app.post('/api/settings', requireAuth, async (req, res) => {
  const allowed = [
    'stripe_secret_key', 'stripe_webhook_secret',
    'plan_website_revamp_url', 'plan_growth_monthly_url', 'plan_premium_monthly_url',
    'payments_enabled'
  ];
  try {
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        await pool.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
          [key, req.body[key]]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: list orders (admin) ──
app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, created_at AS "createdAt", stripe_session_id AS "sessionId",
              customer_email AS email, plan_name AS plan,
              amount_cents AS "amountCents", currency, status
       FROM orders ORDER BY created_at DESC LIMIT 500`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Portfolio page ──
app.get('/portfolio', (req, res) => {
  res.sendFile(path.join(__dirname, 'portfolio.html'));
});

// ── Checkout pages ──
app.get('/checkout/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'checkout-success.html'));
});
app.get('/checkout/cancel', (req, res) => {
  res.redirect('/services#pricing');
});

// ── Business cards ──
app.get('/business-card', (req, res) => {
  res.sendFile(path.join(__dirname, 'business-card.html'));
});
app.get('/business-card-general', (req, res) => {
  res.sendFile(path.join(__dirname, 'business-card-general.html'));
});

// ── Audit page with clean URL: /audit/domain.com ──
app.get('/audit/:site(*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'audit.html'));
});

// ── Admin dashboard ──
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// ── Contract signing page (public) ──
app.get('/contract/:token', async (req, res) => {
  res.sendFile(path.join(__dirname, 'contract.html'));
});

// ── API: list contracts (admin) ──
app.get('/api/contracts', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, token, client_name, client_email, services, amount, start_date,
              notes, status, created_at, sent_at, signed_at, signer_name, expires_at
       FROM contracts ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: create contract (admin) ──
app.post('/api/contracts', requireAuth, async (req, res) => {
  const { client_name, client_email, services, amount, payment_schedule, start_date, notes, send_now } = req.body;
  if (!client_name || !client_email) return res.status(400).json({ error: 'Client name and email required' });
  const token = crypto.randomBytes(24).toString('hex');
  const expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const baseUrl = process.env.BASE_URL || 'https://gorevamp.ai';
  const link = `${baseUrl}/contract/${token}`;
  try {
    const r = await pool.query(
      `INSERT INTO contracts (token, client_name, client_email, services, amount, payment_schedule, start_date, notes, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9) RETURNING *`,
      [token, client_name, client_email, services||'', parseFloat(amount)||0,
       payment_schedule||'', start_date||null, notes||'', expires_at]
    );
    const contract = r.rows[0];
    let emailSent = false;
    let emailError = null;
    if (send_now) {
      try {
        emailSent = await sendMail({
          to: client_email,
          subject: `Your Service Agreement from Revamp Digital LLC`,
          html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
            <div style="background:#0b1220;padding:28px 32px">
              <h2 style="margin:0;color:#3dd6f5;font-size:1.1rem;font-family:Arial,sans-serif">Revamp Digital LLC</h2>
              <p style="margin:4px 0 0;color:rgba(255,255,255,0.5);font-size:0.8rem">Service Agreement — Ready to Sign</p>
            </div>
            <div style="padding:28px 32px;background:#ffffff">
              <p style="margin:0 0 16px;font-size:0.95rem;color:#111">Hi <strong>${client_name}</strong>,</p>
              <p style="margin:0 0 20px;color:#444;font-size:0.9rem;line-height:1.6">We've prepared your service agreement. Please review the details and sign when you're ready.</p>
              <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
                <tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;font-size:0.85rem;color:#666;font-weight:bold">Amount</td><td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:0.95rem;color:#15803d;font-weight:bold">$${parseFloat(amount||0).toLocaleString('en-US',{minimumFractionDigits:2})}</td></tr>
                ${payment_schedule ? `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;font-size:0.85rem;color:#666;font-weight:bold">Payment Schedule</td><td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:0.85rem;color:#444;white-space:pre-line">${payment_schedule}</td></tr>` : ''}
                ${start_date ? `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;font-size:0.85rem;color:#666;font-weight:bold">Start Date</td><td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:0.85rem;color:#444">${new Date(start_date).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</td></tr>` : ''}
              </table>
              <div style="text-align:center;margin:28px 0">
                <a href="${link}" style="background:#1F7A8C;color:#ffffff;font-weight:700;font-size:1rem;padding:14px 36px;border-radius:10px;text-decoration:none;display:inline-block">Review &amp; Sign Agreement →</a>
              </div>
              <p style="margin:20px 0 0;color:#999;font-size:0.78rem;text-align:center">This link expires in 30 days. Questions? Reply to this email or call (385) 253-2318.</p>
            </div>
          </div>`,
        });
        if (emailSent) {
          await pool.query(`UPDATE contracts SET status='sent', sent_at=NOW() WHERE id=$1`, [contract.id]);
        }
      } catch(mailErr) {
        emailError = mailErr.message;
        console.error('[mail send error]', mailErr.message);
      }
    }
    res.json({ ok: true, id: contract.id, token, link, emailSent, emailError });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: resend contract email (admin) ──
app.post('/api/contracts/:id/resend', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM contracts WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const contract = r.rows[0];
    const link = `${process.env.BASE_URL || 'https://gorevamp.ai'}/contract/${contract.token}`;
    await sendMail({
      to: contract.client_email,
      subject: `Reminder: Your Service Agreement from Revamp Digital LLC`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><p>Hi ${contract.client_name},</p><p>Just a reminder — your service agreement is still waiting for your signature.</p><div style="text-align:center;margin:24px 0"><a href="${link}" style="background:linear-gradient(135deg,#3dd6f5,#0fa3b1);color:#05080f;font-weight:700;padding:12px 28px;border-radius:10px;text-decoration:none;display:inline-block">Review &amp; Sign Agreement →</a></div><p style="color:#888;font-size:0.8rem">This link expires on ${new Date(contract.expires_at).toLocaleDateString()}.</p></div>`,
    });
    await pool.query(`UPDATE contracts SET status='sent', sent_at=NOW() WHERE id=$1 AND status!='signed'`, [contract.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: void contract (admin) ──
app.patch('/api/contracts/:id/void', requireAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE contracts SET status='void' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: get contract data for signing page (public) ──
app.get('/api/contract/:token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, client_name, client_email, services, amount, payment_schedule, start_date, notes,
              status, created_at, expires_at, signed_at, signer_name
       FROM contracts WHERE token=$1`, [req.params.token]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Contract not found' });
    const c = r.rows[0];
    if (c.expires_at && new Date(c.expires_at) < new Date() && c.status !== 'signed')
      return res.status(410).json({ error: 'Contract has expired' });
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: sign contract (public) ──
app.post('/api/contract/:token/sign', async (req, res) => {
  const { signer_name } = req.body;
  if (!signer_name || signer_name.trim().length < 2)
    return res.status(400).json({ error: 'Please enter your full name to sign' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
  try {
    const r = await pool.query(`SELECT * FROM contracts WHERE token=$1`, [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Contract not found' });
    const contract = r.rows[0];
    if (contract.status === 'signed') return res.status(409).json({ error: 'Already signed' });
    if (contract.status === 'void') return res.status(410).json({ error: 'This contract has been voided' });
    if (contract.expires_at && new Date(contract.expires_at) < new Date())
      return res.status(410).json({ error: 'Contract has expired' });

    await pool.query(
      `UPDATE contracts SET status='signed', signed_at=NOW(), signer_name=$1, signer_ip=$2 WHERE id=$3`,
      [signer_name.trim(), ip, contract.id]
    );
    contract.status = 'signed';
    contract.signed_at = new Date();
    contract.signer_name = signer_name.trim();
    contract.signer_ip = ip;

    // Generate PDF
    let pdfBuffer;
    try { pdfBuffer = await buildContractPdf(contract); } catch(e) { console.error('[pdf]', e.message); }

    const attach = pdfBuffer ? [{
      filename: `revamp-digital-agreement-${contract.id}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }] : [];

    const dateStr = new Date(contract.signed_at).toLocaleString('en-US');
    // Email client
    await sendMail({
      to: contract.client_email,
      subject: 'Your signed agreement with Revamp Digital LLC',
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><p>Hi ${contract.client_name},</p><p>Thank you for signing your service agreement! A copy is attached to this email.</p><p style="color:#555">Signed on: ${dateStr}</p><p>We'll be in touch shortly to get started. If you have any questions, contact us at <a href="mailto:hello@gorevamp.ai">hello@gorevamp.ai</a>.</p><p>— The Revamp Digital Team</p></div>`,
      attachments: attach,
    });
    // Email admin
    const adminEmail = process.env.ADMIN_EMAIL || await getSetting('admin_email') || 'feyisa.berisa@gorevamp.ai';
    await sendMail({
      to: adminEmail,
      subject: `Contract signed — ${contract.client_name}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto"><p><strong>${contract.client_name}</strong> (${contract.client_email}) just signed their service agreement.</p><p>Amount: <strong>$${parseFloat(contract.amount).toLocaleString('en-US',{minimumFractionDigits:2})}</strong></p><p>Signed at: ${dateStr} · IP: ${ip}</p></div>`,
      attachments: attach,
    });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: download signed PDF (admin) ──
app.get('/api/contracts/:id/pdf', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM contracts WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const pdfBuffer = await buildContractPdf(r.rows[0]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="contract-${r.rows[0].id}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Serve static site with caching ──
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.match(/\.(png|jpg|jpeg|gif|svg|ico|webp)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.match(/\.(css|js)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else if (filePath.match(/\.html$/i)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ── Custom 404 ──
const errorPage = (code, title, message) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} | Revamp Digital LLC</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;background:#05080f;color:#e8f0fe;font-family:'Poppins',sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
    .wrap{max-width:480px}
    .code{font-size:6rem;font-weight:800;background:linear-gradient(135deg,#3dd6f5,#1F7A8C);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1;margin-bottom:16px}
    h1{font-size:1.5rem;font-weight:700;margin-bottom:12px}
    p{font-size:0.92rem;color:rgba(255,255,255,0.45);line-height:1.7;margin-bottom:32px}
    a{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#1F7A8C,#15606e);color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:600;font-size:0.9rem;transition:opacity 0.2s}
    a:hover{opacity:0.85}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="code">${code}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/">← Back to Home</a>
  </div>
</body>
</html>`;

app.use((req, res) => {
  res.status(404).send(errorPage(404, 'Page Not Found', "The page you're looking for doesn't exist. It may have moved or the URL might be incorrect."));
});

app.use((err, req, res, next) => {
  console.error('[server error]', err);
  res.status(500).send(errorPage(500, 'Something Went Wrong', "We hit an unexpected error. Please try again in a moment or contact us at hello@gorevamp.ai."));
});

// ── Start ──
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
initDb().catch(err => console.error('[db init error — add PostgreSQL in Railway]', err.message));
