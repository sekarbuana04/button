const crypto = require('crypto');
let bcrypt = null;
try { bcrypt = require('bcryptjs'); } catch {}
const db = require('./db');

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, s, 120000, 32, 'sha256').toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  if (!hash) return false;
  const hs = String(hash).trim();
  const sl = String(salt || '');
  const isHex = /^[0-9a-fA-F]+$/.test(hs);
  const safeEqHex = (aHex, bHex) => {
    try { return crypto.timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex')); } catch { return false; }
  };
  if (hs.startsWith('$2a$') || hs.startsWith('$2b$') || hs.startsWith('$2y$')) {
    try { if (bcrypt && bcrypt.compareSync(password, hs)) return true; } catch {}
    return false;
  }
  if (isHex) {
    const tryPbkdf2 = (iter) => crypto.pbkdf2Sync(password, sl, iter, 32, 'sha256').toString('hex');
    const candidates = [120000, 100000, 60000, 40000, 20000, 10000, 1000].map(i => tryPbkdf2(i));
    for (const c of candidates) { if (safeEqHex(c, hs)) return true; }
    const sha256Hex = crypto.createHash('sha256').update(sl ? (password + sl) : password).digest('hex');
    if (safeEqHex(sha256Hex, hs)) return true;
    const sha1Hex = crypto.createHash('sha1').update(sl ? (password + sl) : password).digest('hex');
    if (safeEqHex(sha1Hex, hs)) return true;
    const md5Hex = crypto.createHash('md5').update(sl ? (password + sl) : password).digest('hex');
    if (safeEqHex(md5Hex, hs)) return true;
  } else {
    try {
      const pb = crypto.pbkdf2Sync(password, sl, 120000, 32, 'sha256');
      if (Buffer.compare(Buffer.from(hs, 'base64'), pb) === 0) return true;
      const sha256B64 = crypto.createHash('sha256').update(sl ? (password + sl) : password).digest();
      if (Buffer.compare(Buffer.from(hs, 'base64'), sha256B64) === 0) return true;
    } catch {}
  }
  if (password && hs && password === hs) return true;
  return false;
}


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
    const salt = (u.salt ?? u.salt_key ?? '').trim();
    const hash = (u.hash ?? u.password ?? u.pass ?? '').trim();
    const rawLines = u.lines ?? u.line ?? '';
    const lines = typeof rawLines === 'string' && rawLines ? String(rawLines).split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(rawLines) ? rawLines : [];
    return { id, username: unameDb, role, salt, hash, lines };
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
    const salt = u.salt ?? u.salt_key ?? '';
    const hash = u.hash ?? u.password ?? u.pass ?? '';
    const rawLines = u.lines ?? u.line ?? '';
    const lines = typeof rawLines === 'string' && rawLines ? String(rawLines).split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(rawLines) ? rawLines : [];
    return { id: uid, username: uname, role, salt, hash, lines };
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
          const t = hashPassword(techPass);
          await bpool.execute('INSERT INTO master_users (username, role, salt, hash, lines) VALUES (?,?,?,?,?)', ['techadmin', 'tech_admin', t.salt, t.hash, '']);
          for (let i = 1; i <= 50; i++) {
            const u = `admin_line_${i}`;
            const l = [`Line ${i}`].join(',');
            const h = hashPassword(linePass);
            await bpool.execute('INSERT INTO master_users (username, role, salt, hash, lines) VALUES (?,?,?,?,?)', [u, 'line_admin', h.salt, h.hash, l]);
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
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  parseCookie
};
