const crypto = require('crypto');
const db = require('./db');
const FAKE = false;
const fakeUsers = [];

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
    const role = roleRaw === 'admit' || roleRaw === 'adminit' ? 'tech_admin' : roleRaw === 'admline' ? 'line_admin' : roleRaw;
    const password = (u.password ?? u.pass ?? '').trim();
    const rawLines = u.lines ?? u.line ?? '';
    let lines = typeof rawLines === 'string' && rawLines ? String(rawLines).split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(rawLines) ? rawLines : [];
    if (role === 'line_admin' && (!lines || lines.length === 0)) {
      try {
        const all = await db.getMasterLine();
        const names = Array.isArray(all) ? all.map(r => r.nama_line).filter(Boolean) : [];
        const nm = String(nama || '').toUpperCase();
        let guess = null;
        const m = nm.match(/LINE\s*([A-Z0-9\- ]+)/);
        if (m && m[0]) {
          const target = m[0].trim();
          guess = names.find(n => String(n).toUpperCase() === target) || names.find(n => String(n).toUpperCase().includes(target));
        }
        if (!guess) {
          const un = String(unameDb || '').toUpperCase();
          const tok = un.replace(/^ADM[_\-]?/,'').replace(/^ADMLINE[_\-]?/,'');
          if (tok) {
            const candidate = `LINE ${tok}`.replace(/\s+/g,' ').trim();
            guess = names.find(n => String(n).toUpperCase() === candidate);
          }
        }
        if (!guess && names.length) guess = names[0];
        lines = guess ? [guess] : [];
      } catch {}
    }
    return { id, username: unameDb, role, password, lines };
  } catch (e) {
    return null;
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
    const role = roleRaw === 'admit' || roleRaw === 'adminit' ? 'tech_admin' : roleRaw === 'admline' ? 'line_admin' : roleRaw;
    const password = u.password ?? u.pass ?? '';
    const rawLines = u.lines ?? u.line ?? '';
    let lines = typeof rawLines === 'string' && rawLines ? String(rawLines).split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(rawLines) ? rawLines : [];
    if (role === 'line_admin' && (!lines || lines.length === 0)) {
      try {
        const all = await db.getMasterLine();
        const names = Array.isArray(all) ? all.map(r => r.nama_line).filter(Boolean) : [];
        const nm = String(nama || '').toUpperCase();
        let guess = null;
        const m = nm.match(/LINE\s*([A-Z0-9\- ]+)/);
        if (m && m[0]) {
          const target = m[0].trim();
          guess = names.find(n => String(n).toUpperCase() === target) || names.find(n => String(n).toUpperCase().includes(target));
        }
        if (!guess) {
          const un = String(uname || '').toUpperCase();
          const tok = un.replace(/^ADM[_\-]?/,'').replace(/^ADMLINE[_\-]?/,'');
          if (tok) {
            const candidate = `LINE ${tok}`.replace(/\s+/g,' ').trim();
            guess = names.find(n => String(n).toUpperCase() === candidate);
          }
        }
        if (!guess && names.length) guess = names[0];
        lines = guess ? [guess] : [];
      } catch {}
    }
    return { id: uid, username: uname, role, password, lines };
  } catch (e) {
    return null;
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
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expSig))) return null;
  } catch {
    return null;
  }
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
