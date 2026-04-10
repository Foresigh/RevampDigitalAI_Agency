'use strict';

const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const { Pool } = require('pg');

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
      goals       TEXT,
      status      TEXT DEFAULT 'new',
      notes       TEXT DEFAULT ''
    )
  `);
  console.log('[db] leads table ready');
}

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
      `INSERT INTO leads (owner_name, business_name, business_type, email, phone, current_website, goals)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        owner_name,
        b.business_name || b.business || '',
        b.business_type || b.reason  || '',
        email,
        b.phone           || '',
        b.current_website || '',
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

// ── API: get all leads (admin only) ──
app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, submitted_at AS "submittedAt", owner_name, business_name,
              business_type, email, phone, current_website, goals, status, notes
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

// ── Admin dashboard ──
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// ── Serve static site ──
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ── Start ──
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
initDb().catch(err => console.error('[db init error — add PostgreSQL in Railway]', err.message));
