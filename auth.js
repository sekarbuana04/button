const crypto = require('crypto');
const db = require('./db');

async function getUserByUsernameAsync(username) {
  try {
    await db.ensureButtonSchema();
    const bpool = db.getButtonPool();
    const unameQuery = String(username).trim();
    let rows = [];
    try { [rows] = await bpool.execute('SELECT * FROM master_users WHERE username = ? LIMIT 1', [unameQuery]); } catch (e) { throw e; }
    if (!rows || !rows.length) {
      try { [rows] = await bpool.execute('SELECT * FROM master_users WHERE user = ? LIMIT 1', [unameQuery]); } catch {}
    }
    if (!rows || !rows.length) {
      try { [rows] = await bpool.execute('SELECT * FROM master_users WHERE user_name = ? LIMIT 1', [unameQuery]); } catch {}
    }
    if (!rows.length) return null;
    const u = rows[0] || {};
    const id = u.id ?? u.id_user ?? u.user_id ?? null;
    const unameDb = u.username ?? u.user ?? u.user_name ?? String(username);
    const nama = u.nama ?? u.name ?? '';
    let roleRaw = u.role ?? u.level ?? u.user_role;
    if (!roleRaw) {
      const nm = String(nama).toUpperCase();
      roleRaw = nm.startsWith('LINE') ? 'admline' : 'admit';
    }
    const role = roleRaw === 'admit' ? 'tech_admin' : roleRaw === 'admline' ? 'line_admin' : roleRaw;
    const password = (u.password ?? u.pass ?? '').trim();
    const rawLines = u.lines ?? u.line ?? '';
    const lines = typeof rawLines === 'string' && rawLines ? String(rawLines).split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(rawLines) ? rawLines : [];
    return { id, username: unameDb, role, password, lines };
  } catch (e) {
    return { error: 'db_error', message: String(e && e.message || '') };
  }
}

async function getUserByIdAsync(id) {
  try {
    await db.ensureButtonSchema();
    const bpool = db.getButtonPool();
    const [rows] = await bpool.execute('SELECT * FROM master_users WHERE id = ?', [id]);
    if (!rows.length) return null;
    const u = rows[0] || {};
    const uid = u.id ?? u.id_user ?? u.user_id ?? id;
    const uname = u.username ?? u.user ?? u.user_name ?? null;
    const nama = u.nama ?? u.name ?? '';
    let roleRaw = u.role ?? u.level ?? u.user_role;
    if (!roleRaw) {
      const nm = String(nama).toUpperCase();
      roleRaw = nm.startsWith('LINE') ? 'admline' : 'admit';
    }
    const role = roleRaw === 'admit' ? 'tech_admin' : roleRaw === 'admline' ? 'line_admin' : roleRaw;
    const password = u.password ?? u.pass ?? '';
    const rawLines = u.lines ?? u.line ?? '';
    const lines = typeof rawLines === 'string' && rawLines ? String(rawLines).split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(rawLines) ? rawLines : [];
    return { id: uid, username: uname, role, password, lines };
  } catch (e) {
    return { error: 'db_error', message: String(e && e.message || '') };
  }
}


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

function seedIfEmpty() {}

module.exports = {
  seedIfEmpty,
  getUserByUsernameAsync,
  getUserByIdAsync,
  signToken,
  verifyToken,
  parseCookie
};
