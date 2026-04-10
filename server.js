'use strict';

const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'revamp2024';
const SESSION_SECRET = process.env.SESSION_SECRET || 'revamp-secret-key-change-me';
const LEADS_FILE     = path.join(__dirname, 'leads.json');

// ── Leads persistence helpers ──
function readLeads() {
  try {
    if (!fs.existsSync(LEADS_FILE)) return [];
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch { return []; }
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
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

// ── API: receive form submission from website ──
app.post('/api/submit', (req, res) => {
  const b = req.body;
  const owner_name = b.owner_name || b.name || '';
  const email      = b.email || '';
  if (!owner_name || !email) return res.status(400).json({ error: 'Missing required fields' });

  const lead = {
    id: Date.now().toString(),
    submittedAt: new Date().toISOString(),
    owner_name,
    business_name: b.business_name || b.business || '',
    business_type: b.business_type || b.reason || '',
    email,
    phone: b.phone || '',
    current_website: b.current_website || '',
    goals: b.goals || b.message || ''
  };

  try {
    const leads = readLeads();
    leads.unshift(lead);
    writeLeads(leads);
    console.log(`[lead saved] ${lead.owner_name} <${lead.email}> — total: ${leads.length}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[lead save error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: get all leads (admin only) ──
app.get('/api/leads', requireAuth, (req, res) => {
  const leads = readLeads();
  console.log(`[api/leads] returning ${leads.length} leads, file: ${LEADS_FILE}`);
  res.json(leads);
});

// ── Admin dashboard (serves the HTML) ──
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// ── Serve static site ──
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ── Start ──
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
