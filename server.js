'use strict';

const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const { Pool }   = require('pg');
const fetch      = require('node-fetch');
const compression= require('compression');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'revamp2024';
const SESSION_SECRET = process.env.SESSION_SECRET || 'revamp-secret-key-change-me';

// ── PostgreSQL ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

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
      url          TEXT
    )
  `);
  console.log('[db] tables ready');
}

app.use(compression());
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

  // Suggestion based on worst problem
  let suggestion;
  if (mobileFriendly < 60)
    suggestion = "Over 70% of your potential customers search on their phones. Your site has serious mobile issues that are causing most visitors to leave immediately. A mobile-first revamp could immediately increase calls and form submissions.";
  else if (perf < 50)
    suggestion = "Your biggest win is fixing page speed. A site that loads in under 3 seconds converts 3x better than one that takes 8+ seconds. On mobile, most visitors leave before your page finishes loading — fixing this alone could double your leads.";
  else if (seo < 60)
    suggestion = "Your site has SEO gaps making it nearly invisible to Google. Local businesses that rank on page 1 get 10x more calls than those on page 2. Fixing your titles, meta descriptions, and content structure is the fastest path to free organic leads.";
  else if (accessibility < 70)
    suggestion = "Your site has accessibility issues that are also hurting your SEO. Google uses accessibility signals as a ranking factor. Fixing alt text, contrast, and label issues will help both disabled visitors and your search rankings.";
  else if (bestPractices < 70)
    suggestion = "Your site has security and code quality issues flagged by Google. Using HTTPS everywhere, removing insecure scripts, and fixing console errors will improve trust scores and protect your visitors.";
  else
    suggestion = "Adding a visible phone number and a 'Call Now' button above the fold could increase your leads by 20–40%. Most mobile visitors want to call — not fill out a form. Make it as easy as possible for them to contact you the moment they land on your page.";

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
  try {
    await pool.query(
      `INSERT INTO audit_downloads (email, url) VALUES ($1, $2)`,
      [email, url || '']
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[audit-email error]', e.message);
    res.status(500).json({ error: 'Could not save email' });
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

// ── Audit page with clean URL: /audit/domain.com ──
app.get('/audit/:site(*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'audit.html'));
});

// ── Admin dashboard ──
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
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
