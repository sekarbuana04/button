const crypto = require('crypto');
const db = require('./db');

async function getUserByUsernameAsync(username) {
  try {
    await db.ensureButtonSchema();
    const bpool = db.getButtonPool();
    const unameQuery = String(username).trim();
    const [rows] = await bpool.execute('SELECT * FROM master_users WHERE username = ? OR user = ? OR user_name = ? LIMIT 1', [unameQuery, unameQuery, unameQuery]);
    if (!rows.length) return null;
    const u = rows[0] || {};
    const id = u.id ?? u.id_user ?? u.user_id ?? null;
    const unameDb = u.username ?? u.user ?? u.user_name ?? String(username);
    const role = u.role ?? u.level ?? u.user_role ?? 'tech_admin';
    const password = (u.password ?? u.pass ?? '').trim();
    const rawLines = u.lines ?? u.line ?? '';
    const lines = typeof rawLines === 'string' && rawLines ? String(rawLines).split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(rawLines) ? rawLines : [];
    return { id, username: unameDb, role, password, lines };
  } catch {
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
    const role = u.role ?? u.level ?? u.user_role ?? 'tech_admin';
    const password = u.password ?? u.pass ?? '';
    const rawLines = u.lines ?? u.line ?? '';
    const lines = typeof rawLines === 'string' && rawLines ? String(rawLines).split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(rawLines) ? rawLines : [];
    return { id: uid, username: uname, role, password, lines };
  } catch {
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
  (async () => {
    try {
      await db.ensureButtonSchema();
      const bpool = db.getButtonPool();
      if (bpool) {
        const [cntRows] = await bpool.query('SELECT COUNT(*) AS c FROM master_users');
        const c = (cntRows && cntRows[0] && (cntRows[0].c || cntRows[0].C)) || 0;
        if (c === 0) {
          const techPass = process.env.ADMIN_TECH_PASSWORD || 'admin123';
          const linePass = process.env.ADMIN_LINE_PASSWORD || 'line123';
          await bpool.execute('INSERT INTO master_users (username, role, password, lines) VALUES (?,?,?,?)', ['techadmin', 'tech_admin', techPass, '']);
          for (let i = 1; i <= 50; i++) {
            const u = `admin_line_${i}`;
            const l = [`Line ${i}`].join(',');
            await bpool.execute('INSERT INTO master_users (username, role, password, lines) VALUES (?,?,?,?)', [u, 'line_admin', linePass, l]);
          }
        }
      }
    } catch {}
  })();
}

module.exports = {
  seedIfEmpty,
  getUserByUsernameAsync,
  getUserByIdAsync,
  signToken,
  verifyToken,
  parseCookie
};
