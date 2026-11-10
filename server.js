'use strict';
/*
 * Allymar Hourly — web server.
 * Express + PostgreSQL. Passwords are hashed with scrypt; sessions are random
 * tokens in an HttpOnly cookie (only a hash is stored); writes need a CSRF token.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool, types } = require('pg');
const PP = require('./public/payperiod.js');

types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // NUMERIC -> number

const PORT = process.env.PORT || 3000;
const TZ = process.env.APP_TIMEZONE || 'America/New_York';
const PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;
const COOKIE = PROD ? '__Host-sid' : 'sid';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
});
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0] || null;
const all = async (text, params) => (await q(text, params)).rows;

// ------------------------------------------------------------------ schema
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'worker')),
  rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  schedule JSONB NOT NULL DEFAULT '{"type":"biweekly","payday":"2026-10-12"}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entries (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  hours NUMERIC(5,2) NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  due_date TEXT NOT NULL,
  hours NUMERIC(8,2) NOT NULL,
  rate NUMERIC(10,2) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_amount NUMERIC(12,2),
  process_date TEXT
);
CREATE INDEX IF NOT EXISTS invoices_user ON invoices(user_id, period_start);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ------------------------------------------------------------------ passwords
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [kind, saltB64, hashB64] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const want = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
// Equalizes timing when the username doesn't exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function genPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 12; i++) { s += A[crypto.randomInt(A.length)]; if (i === 3 || i === 7) s += '-'; }
  return s;
}
function baseUsername(name) {
  const parts = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').split(/[\s-]+/).filter(Boolean);
  const b = (parts.length > 1 ? `${parts[0]}.${parts[parts.length - 1]}` : parts[0] || '').slice(0, 28);
  return b.length >= 2 ? b : 'user';
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ helpers
const today = () => PP.dateIn(TZ);
const cents = (n) => Math.round(n * 100) / 100;

function err(msg, status = 400) { const e = new Error(msg); e.status = status; e.expose = true; return e; }

async function getSettings() {
  const rows = await all('SELECT key, value FROM settings');
  const s = { business: 'Allymar Health Solutions', phone: '' };
  for (const r of rows) s[r.key] = r.value;
  return s;
}
async function publicSettings() {
  const s = await getSettings();
  const o = await one("SELECT name, email FROM users WHERE role = 'owner' ORDER BY id LIMIT 1");
  return { business: s.business, phone: s.phone, ownerName: o ? o.name : '', ownerEmail: (o && o.email) || '' };
}
const userById = (id) => one('SELECT * FROM users WHERE id = $1', [id]);
const scheduleOf = (u) => PP.normalize(u.schedule || PP.DEFAULT_SCHEDULE);

async function entriesRange(uid, from, to) {
  return all('SELECT date, hours, notes FROM entries WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date', [uid, from, to]);
}
async function sumRange(uid, from, to) {
  const r = await one('SELECT COALESCE(SUM(hours), 0) AS s FROM entries WHERE user_id = $1 AND date >= $2 AND date <= $3', [uid, from, to]);
  return Number(r.s);
}
async function overlapping(uid, p) {
  return all('SELECT * FROM invoices WHERE user_id = $1 AND period_start <= $2 AND period_end >= $3 ORDER BY period_start', [uid, p.end, p.start]);
}
function describe(p, hours, rate) {
  const f = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(2, 4)}`;
  return `Hours worked ${f(p.start)}–${f(p.end)}: ${hours.toFixed(2)} hrs × $${rate.toFixed(2)}/hr`;
}
function pub(i, u) {
  if (!i) return null;
  return {
    id: i.id, number: i.number, periodStart: i.period_start, periodEnd: i.period_end, dueDate: i.due_date,
    hours: i.hours, rate: i.rate, amount: i.amount, description: i.description, status: i.status,
    sentAt: i.sent_at, paymentAmount: i.payment_amount, processDate: i.process_date,
    personId: i.user_id, personName: u ? u.name : (i.person_name || ''), personEmail: u ? (u.email || '') : (i.person_email || ''),
  };
}
async function openPeriod(uid, p) {
  const ov = await overlapping(uid, p);
  const exact = ov.find((i) => i.period_start <= p.start && i.period_end >= p.end)
    || ov.find((i) => i.period_start >= p.start && i.period_end === p.end);
  if (exact) return { period: { start: exact.period_start, end: exact.period_end, due: exact.due_date }, invoice: exact };
  let start = p.start;
  for (const i of ov) if (i.period_end >= start) start = PP.addDays(i.period_end, 1);
  if (start > p.end) start = p.end;
  return { period: { start, end: p.end, due: p.due }, invoice: null };
}
async function periodView(user, startParam) {
  const sched = scheduleOf(user);
  let p = PP.periodFor(today(), sched);
  if (startParam) { if (!PP.isValidDate(startParam)) throw err('Invalid date.'); p = PP.periodFor(startParam, sched); }
  const { period, invoice } = await openPeriod(user.id, p);
  const hours = await sumRange(user.id, period.start, period.end);
  const rate = invoice ? invoice.rate : user.rate;
  return {
    period, schedule: sched, prevStart: PP.prevPeriod(p, sched).start, nextStart: PP.nextPeriod(p, sched).start, today: today(),
    entries: await entriesRange(user.id, period.start, period.end), hours, rate, amount: cents(hours * rate), invoice: pub(invoice, user),
    person: { id: user.id, name: user.name, email: user.email || '', username: user.username, rate: user.rate },
  };
}
function readSchedule(raw) {
  const type = raw && raw.type;
  if (type === 'monthly') return { type: 'monthly' };
  if (type === 'weekly' || type === 'biweekly') {
    const payday = raw.payday || PP.DEFAULT_SCHEDULE.payday;
    if (!PP.isValidDate(payday)) throw err('Pick a payday date.');
    return { type, payday };
  }
  throw err('Choose how often this person is paid.');
}
function readName(v) { const n = String(v || '').trim().replace(/\s+/g, ' '); if (n.length < 2 || n.length > 80) throw err('Enter their full name.'); return n; }
function readEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!e) throw err('Enter their email address.');
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw err('Enter a valid email address, like name@example.com.');
  return e;
}
function readRate(v) {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10000 || String(v ?? '').trim() === '') throw err('Enter an hourly rate, like 45 or 45.50.');
  return cents(n);
}
const workerRow = ({ password_hash, ...u }) => ({ ...u, email: u.email || '', schedule: scheduleOf(u) });

// ------------------------------------------------------------------ sessions
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, value, maxAgeSec) {
  const bits = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (PROD) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}
async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  await q("INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)", [sha(token), userId, csrf, String(SESSION_DAYS)]);
  setCookie(res, token, SESSION_DAYS * 86400);
  return csrf;
}
async function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const sid = sha(token);
  const s = await one('SELECT csrf, user_id FROM sessions WHERE id = $1 AND expires_at > now()', [sid]);
  if (!s) return null;
  const user = await userById(s.user_id);
  if (!user || !user.active) return null;
  return { sid, csrf: s.csrf, user };
}

// Simple login throttle: 10 failed tries per IP per 15 minutes.
const fails = new Map();
function throttled(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() > f.reset) { fails.delete(ip); return false; }
  return f.count >= 10;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() > f.reset) fails.set(ip, { count: 1, reset: Date.now() + 15 * 60e3 });
  else f.count++;
}

// ------------------------------------------------------------------ app
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', express.json({ limit: '50kb' }));

const route = (fn) => async (req, res) => {
  try {
    const sess = await loadSession(req);
    req.me = sess ? sess.user : null;
    req.sess = sess;
    if (req.method !== 'GET' && req.path !== '/login') {
      if (!sess || req.get('X-CSRF-Token') !== sess.csrf) throw err('Your session expired. Please sign in again.', 401);
    }
    res.set('Cache-Control', 'no-store');
    res.json(await fn(req, res));
  } catch (e) {
    if (!e.expose) console.error(e);
    res.status(e.status || 500).json({ error: e.expose ? e.message : 'Something went wrong on the server.' });
  }
};
function need(req, role) {
  if (!req.me || !req.me.active) throw err('Please sign in.', 401);
  if (role && req.me.role !== role) throw err('You don’t have access to that.', 403);
}

const api = express.Router();

api.get('/me', route(async (req) => {
  const me = req.me;
  return {
    user: me ? { id: me.id, name: me.name, username: me.username, email: me.email || '', role: me.role, rate: me.rate } : null,
    csrf: req.sess ? req.sess.csrf : null, settings: await publicSettings(), today: today(),
  };
}));

api.post('/login', route(async (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) throw err('Too many tries. Wait 15 minutes and try again.', 429);
  const login = String(req.body.username || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!login || !pw) throw err('Enter your username and password.');
  const u = await one('SELECT * FROM users WHERE lower(username) = $1 OR (email IS NOT NULL AND email = $1)', [login]);
  const ok = checkPassword(pw, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) { noteFail(ip); throw err('That username and password don’t match.', 401); }
  if (!u.active) throw err('This account has been turned off. Ask the owner to turn it back on.', 403);
  fails.delete(ip);
  const csrf = await createSession(res, u.id);
  return { ok: true, csrf };
}));

api.post('/logout', route(async (req, res) => {
  if (req.sess) await q('DELETE FROM sessions WHERE id = $1', [req.sess.sid]);
  setCookie(res, '', 0);
  return { ok: true };
}));

api.post('/account/password', route(async (req) => {
  need(req);
  if (!checkPassword(String(req.body.current || ''), req.me.password_hash)) throw err('Your current password isn’t right.');
  const next = String(req.body.next || '');
  if (next.length < 10) throw err('Password must be at least 10 characters.');
  if (next.length > 200) throw err('Password must be 200 characters or fewer.');
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(next), req.me.id]);
  await q('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.me.id, req.sess.sid]);
  return { ok: true };
}));

// ---- worker
api.get('/my/period', route(async (req) => { need(req, 'worker'); return periodView(req.me, req.query.start); }));

api.put('/my/entries/:date', route(async (req) => {
  need(req, 'worker');
  const date = req.params.date;
  if (!PP.isValidDate(date)) throw err('Invalid date.');
  const locked = await one('SELECT 1 FROM invoices WHERE user_id = $1 AND period_start <= $2 AND period_end >= $2', [req.me.id, date]);
  if (locked) throw err('This day is on an invoice you already sent.', 409);
  const hours = Math.min(24, Math.max(0, Math.round(Number(req.body.hours) * 4) / 4)) || 0;
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  if (hours === 0 && !notes) await q('DELETE FROM entries WHERE user_id = $1 AND date = $2', [req.me.id, date]);
  else await q(`INSERT INTO entries (user_id, date, hours, notes) VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, date) DO UPDATE SET hours = EXCLUDED.hours, notes = EXCLUDED.notes, updated_at = now()`, [req.me.id, date, hours, notes]);
  return { ok: true };
}));

api.post('/my/invoices', route(async (req) => {
  need(req, 'worker');
  const me = req.me;
  const start = String(req.body.start || '');
  if (!PP.isValidDate(start)) throw err('Invalid date.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [me.id]);
    const sched = scheduleOf(me);
    const open = await openPeriod(me.id, PP.periodFor(start, sched));
    if (open.invoice) throw err('You already sent an invoice for this pay period.', 409);
    if (open.period.start !== start) throw err('That pay period has changed. Refresh and try again.', 409);
    const p = open.period;
    const hours = await sumRange(me.id, p.start, p.end);
    if (hours <= 0) throw err('Add your hours before sending an invoice.', 409);
    await client.query(`INSERT INTO invoices (user_id, number, period_start, period_end, due_date, hours, rate, amount, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [me.id, PP.invoiceNumber(p, sched), p.start, p.end, p.due, hours, me.rate, cents(hours * me.rate), describe(p, hours, me.rate)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return { ok: true };
}));

api.get('/my/history', route(async (req) => {
  need(req, 'worker');
  const inv = await all('SELECT * FROM invoices WHERE user_id = $1 ORDER BY due_date DESC', [req.me.id]);
  const rows = inv.map((i) => ({
    periodStart: i.period_start, periodEnd: i.period_end, payday: i.due_date, hours: i.hours, rate: i.rate,
    amount: i.amount, status: i.status, sentAt: i.sent_at, paidAmount: i.payment_amount, paidOn: i.process_date,
  }));
  const year = today().slice(0, 4);
  const paid = rows.filter((r) => r.status === 'paid');
  return {
    rows, year,
    paidThisYear: cents(paid.filter((r) => (r.paidOn || '').startsWith(year)).reduce((a, r) => a + r.paidAmount, 0)),
    paidAllTime: cents(paid.reduce((a, r) => a + r.paidAmount, 0)),
    waiting: cents(rows.filter((r) => r.status !== 'paid').reduce((a, r) => a + r.amount, 0)),
  };
}));

// ---- owner
api.get('/invoices/:id(\\d+)', route(async (req) => {
  need(req, 'owner');
  const inv = await one('SELECT * FROM invoices WHERE id = $1', [+req.params.id]);
  if (!inv) throw err('Invoice not found.', 404);
  const u = await userById(inv.user_id);
  return { invoice: pub(inv, u), person: { name: u.name, email: u.email || '' }, entries: await entriesRange(u.id, inv.period_start, inv.period_end), settings: await publicSettings(), today: today() };
}));

api.get('/owner/overview', route(async (req) => {
  need(req, 'owner');
  const td = today();
  const ws = await all("SELECT * FROM users WHERE role = 'worker' AND active ORDER BY lower(name)");
  const rows = [];
  for (const u of ws) {
    const sched = scheduleOf(u);
    const { period, invoice: inv } = await openPeriod(u.id, PP.periodFor(td, sched));
    const hours = inv ? inv.hours : await sumRange(u.id, period.start, period.end);
    const rate = inv ? inv.rate : u.rate;
    rows.push({ id: u.id, name: u.name, email: u.email || '', schedule: sched, rate, period, hours, amount: inv ? inv.amount : cents(hours * rate), invoice: pub(inv, u) });
  }
  return { today: td, rows };
}));

api.get('/owner/people/:id(\\d+)/period', route(async (req) => {
  need(req, 'owner');
  const u = await userById(+req.params.id);
  if (!u || u.role !== 'worker') throw err('Person not found.', 404);
  return periodView(u, req.query.start);
}));

api.get('/owner/invoices', route(async (req) => {
  need(req, 'owner');
  const list = await all(`SELECT i.*, u.name AS person_name, u.email AS person_email FROM invoices i JOIN users u ON u.id = i.user_id
    ORDER BY (i.status = 'paid'), i.due_date DESC`);
  return { invoices: list.map((i) => pub(i)), today: today() };
}));

async function invoiceOr404(id) {
  const inv = await one('SELECT * FROM invoices WHERE id = $1', [id]);
  if (!inv) throw err('Invoice not found.', 404);
  return inv;
}
api.post('/owner/invoices/:id(\\d+)/pay', route(async (req) => {
  need(req, 'owner');
  const inv = await invoiceOr404(+req.params.id);
  const b = req.body;
  const amt = b.paymentAmount === '' || b.paymentAmount == null ? inv.amount : Number(String(b.paymentAmount).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amt) || amt < 0) throw err('Enter the amount you paid.');
  if (!PP.isValidDate(b.processDate || '')) throw err('Enter the date you paid.');
  const row = await one("UPDATE invoices SET status = 'paid', payment_amount = $1, process_date = $2 WHERE id = $3 RETURNING *", [cents(amt), b.processDate, inv.id]);
  return { ok: true, invoice: pub(row, await userById(row.user_id)) };
}));
api.post('/owner/invoices/:id(\\d+)/unpay', route(async (req) => {
  need(req, 'owner');
  const inv = await invoiceOr404(+req.params.id);
  const row = await one("UPDATE invoices SET status = 'sent', payment_amount = NULL, process_date = NULL WHERE id = $1 RETURNING *", [inv.id]);
  return { ok: true, invoice: pub(row, await userById(row.user_id)) };
}));
api.delete('/owner/invoices/:id(\\d+)', route(async (req) => {
  need(req, 'owner');
  const inv = await invoiceOr404(+req.params.id);
  if (inv.status === 'paid') throw err('This invoice is marked paid. Mark it unpaid first.', 409);
  await q('DELETE FROM invoices WHERE id = $1', [inv.id]);
  return { ok: true };
}));

api.post('/owner/people', route(async (req) => {
  need(req, 'owner');
  const b = req.body;
  const name = readName(b.name), email = readEmail(b.email), rate = readRate(b.rate);
  const schedule = b.schedule ? readSchedule(b.schedule) : PP.DEFAULT_SCHEDULE;
  if (await one('SELECT 1 FROM users WHERE email = $1', [email])) throw err('Someone already has that email address.', 409);
  const base = baseUsername(name);
  let username = base;
  for (let i = 2; await one('SELECT 1 FROM users WHERE lower(username) = $1', [username]); i++) username = base + i;
  const password = genPassword();
  const u = await one(`INSERT INTO users (name, username, email, password_hash, role, rate, schedule)
    VALUES ($1, $2, $3, $4, 'worker', $5, $6) RETURNING id`, [name, username, email, hashPassword(password), rate, JSON.stringify(schedule)]);
  return { ok: true, person: { id: u.id, name, email, rate, username }, username, password };
}));

api.get('/owner/people', route(async (req) => {
  need(req, 'owner');
  const ws = await all("SELECT * FROM users WHERE role = 'worker' ORDER BY active DESC, lower(name)");
  return { people: ws.map(workerRow) };
}));

api.post('/owner/people/:id(\\d+)/new-password', route(async (req) => {
  need(req, 'owner');
  const u = await userById(+req.params.id);
  if (!u || u.role !== 'worker') throw err('Person not found.', 404);
  const password = genPassword();
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), u.id]);
  await q('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  return { ok: true, username: u.username, password };
}));

api.all('/owner/people/:id(\\d+)', route(async (req) => {
  need(req, 'owner');
  if (req.method === 'GET') throw err('Not found.', 404);
  const u = await userById(+req.params.id);
  if (!u || u.role !== 'worker') throw err('Person not found.', 404);
  const b = req.body;
  if (b.name !== undefined) u.name = readName(b.name);
  if (b.email !== undefined) {
    const e = readEmail(b.email);
    if (await one('SELECT 1 FROM users WHERE id <> $1 AND email = $2', [u.id, e])) throw err('Someone already has that email address.', 409);
    u.email = e;
  }
  if (b.rate !== undefined) u.rate = readRate(b.rate);
  if (b.active !== undefined) u.active = b.active === true;
  if (b.schedule !== undefined) u.schedule = readSchedule(b.schedule);
  await q('UPDATE users SET name = $1, email = $2, rate = $3, active = $4, schedule = $5 WHERE id = $6',
    [u.name, u.email, u.rate, u.active, JSON.stringify(u.schedule), u.id]);
  if (!u.active) await q('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  return { ok: true };
}));

api.all('/owner/settings', route(async (req) => {
  need(req, 'owner');
  if (req.method === 'PUT' || req.method === 'POST') {
    const b = req.body;
    if (b.business !== undefined) {
      const v = String(b.business).trim();
      if (!v) throw err('Enter your business name.');
      await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['business', v.slice(0, 100)]);
    }
    if (b.phone !== undefined) {
      await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['phone', String(b.phone).trim().slice(0, 40)]);
    }
  }
  return { ok: true, settings: await publicSettings(), today: today() };
}));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: PROD ? '1h' : 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ------------------------------------------------------------------ startup
async function init() {
  await q(SCHEMA);
  await q('DELETE FROM sessions WHERE expires_at < now()');
  await q("INSERT INTO settings (key, value) VALUES ('business', 'Allymar Health Solutions'), ('phone', '480-229-1914') ON CONFLICT DO NOTHING");
  const owner = await one("SELECT id FROM users WHERE role = 'owner' LIMIT 1");
  if (!owner) {
    const name = process.env.OWNER_NAME || 'Chris Lowry';
    const username = (process.env.OWNER_USERNAME || 'chris.lowry').toLowerCase();
    let password = process.env.OWNER_PASSWORD;
    if (!password) {
      password = genPassword();
      console.log(`Created owner account. Username: ${username}  Password: ${password}`);
    } else {
      console.log(`Created owner account "${username}" with the password from OWNER_PASSWORD.`);
    }
    await q("INSERT INTO users (name, username, email, password_hash, role) VALUES ($1, $2, $3, $4, 'owner')",
      [name, username, process.env.OWNER_EMAIL ? process.env.OWNER_EMAIL.toLowerCase() : null, hashPassword(password)]);
  }
}

if (require.main === module) {
  init().then(() => app.listen(PORT, () => console.log(`Allymar Hourly listening on port ${PORT}`)))
    .catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}
module.exports = { app, init, pool, hashPassword };
