const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const usersPath = path.join(dataDir, 'users.json');

let users = [];

function saveUsers() { fs.writeFileSync(usersPath, JSON.stringify(users, null, 2)); }
function loadUsers() { if (fs.existsSync(usersPath)) { try { users = JSON.parse(fs.readFileSync(usersPath, 'utf-8')) || []; } catch {} } }

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, s, 120000, 32, 'sha256').toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  const h = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

function getUserByUsername(username) { return users.find(u => u.username.toLowerCase() === String(username).toLowerCase()); }
function getUserById(id) { return users.find(u => u.id === id); }

async function getUserByUsernameAsync(username) {
  try {
    await db.initMySQL();
    const pool = db.getMySQLPool();
    if (!pool) return getUserByUsername(username);
    const [rows] = await pool.execute('SELECT id, username, role, salt, hash FROM users WHERE username = ?', [String(username)]);
    if (!rows.length) return null;
    const u = rows[0];
    const [ls] = await pool.execute('SELECT line_id FROM user_lines WHERE user_id = ?', [u.id]);
    return { id: u.id, username: u.username, role: u.role, salt: u.salt, hash: u.hash, lines: ls.map(r => r.line_id) };
  } catch {
    return getUserByUsername(username);
  }
}

async function getUserByIdAsync(id) {
  try {
    await db.initMySQL();
    const pool = db.getMySQLPool();
    if (!pool) return getUserById(id);
    const [rows] = await pool.execute('SELECT id, username, role, salt, hash FROM users WHERE id = ?', [id]);
    if (!rows.length) return null;
    const u = rows[0];
    const [ls] = await pool.execute('SELECT line_id FROM user_lines WHERE user_id = ?', [u.id]);
    return { id: u.id, username: u.username, role: u.role, salt: u.salt, hash: u.hash, lines: ls.map(r => r.line_id) };
  } catch {
    return getUserById(id);
  }
}

function createUser({ username, password, role, lines = [] }) {
  if (getUserByUsername(username)) throw new Error('username_exists');
  const id = crypto.randomUUID();
  const { salt, hash } = hashPassword(password);
  const user = { id, username, salt, hash, role, lines };
  users.push(user); saveUsers();
  return { id, username, role, lines };
}

function listUsersPublic() { return users.map(({ id, username, role, lines }) => ({ id, username, role, lines })); }

function signToken(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token) return null;
  const parts = String(token).split('.'); if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expSig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expSig))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')); } catch { return null; }
}

function parseCookie(cookieHeader) {
  const out = {}; if (!cookieHeader) return out;
  const parts = cookieHeader.split(';');
  for (const p of parts) { const idx = p.indexOf('='); if (idx > -1) { const k = p.slice(0, idx).trim(); const v = decodeURIComponent(p.slice(idx + 1).trim()); out[k] = v; } }
  return out;
}

function seedIfEmpty() {
  loadUsers();
  if (users.length === 0) {
    const techPass = process.env.ADMIN_TECH_PASSWORD || 'admin123';
    const linePass = process.env.ADMIN_LINE_PASSWORD || 'line123';
    try { createUser({ username: 'techadmin', password: techPass, role: 'tech_admin', lines: [] }); } catch {}
    for (let i = 1; i <= 50; i++) {
      const uname = `admin_line_${i}`;
      const lines = [`Line ${i}`];
      try { createUser({ username: uname, password: linePass, role: 'line_admin', lines }); } catch {}
    }
  }
}

module.exports = {
  users,
  loadUsers,
  saveUsers,
  seedIfEmpty,
  createUser,
  listUsersPublic,
  getUserByUsername,
  getUserById,
  getUserByUsernameAsync,
  getUserByIdAsync,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  parseCookie
};
