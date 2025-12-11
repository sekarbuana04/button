const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');
const auth = require('./auth');
const { exportMySQLSQL } = require('./db_export');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const SIMULATE = (process.env.SIMULATE || 'false').toLowerCase() === 'true';
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

db.seedInitial();
auth.seedIfEmpty();

async function emitState() {
  const state = await db.getStateLive();
  io.emit('updateData', { ...state, timestamp: Date.now() });
}

async function simulateIntoDb() {
  const lines = await db.getLinesLive();
  for (const L of lines) {
    const lineStatus = await db.getLineStatusLive(L);
    if (lineStatus === 'offline') continue;
    const arr = await db.getLineLive(L);
    if (!arr || arr.length === 0) continue;
    const active = arr.filter(m => m.status !== 'offline');
    if (active.length === 0) continue;
    const idx = Math.floor(Math.random() * active.length);
    const incGood = Math.random() < 0.9 ? Math.floor(Math.random() * 4) : 0;
    const incReject = Math.random() < 0.15 ? 1 : 0;
    db.incrementMachine({ line: L, machine: active[idx].machine, goodDelta: incGood, rejectDelta: incReject });
  }
}

io.on('connection', async (socket) => {
  const state = await db.getStateLive();
  socket.emit('updateData', { ...state, timestamp: Date.now() });
});

setInterval(async () => {
  if (SIMULATE) await simulateIntoDb();
  await emitState();
}, 1000);

app.get('/api/state', async (req, res) => {
  const state = await db.getStateLive();
  res.json(state);
});

app.get('/api/lines', async (req, res) => {
  const lines = await db.getLinesLive();
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role === 'line_admin') {
    const allowed = Array.isArray(user.lines) ? user.lines : [];
    return res.json({ lines: lines.filter(l => allowed.includes(l)) });
  }
  res.json({ lines });
});

app.get('/api/lines/:line', async (req, res) => {
  const data = await db.getLineLive(req.params.line);
  res.json({ line: req.params.line, data });
});

app.get('/api/lines/:line/style', async (req, res) => {
  const style = await db.getLineStyleLive(req.params.line);
  res.json({ line: req.params.line, style });
});

app.get('/api/lines/:line/status', async (req, res) => {
  const status = await db.getLineStatusLive(req.params.line);
  res.json({ line: req.params.line, status });
});

app.post('/api/lines/:line/style', async (req, res) => {
  const { style } = req.body || {};
  if (!style) return res.status(400).json({ error: 'style wajib' });
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (!canEditLine(user, req.params.line)) return res.status(403).json({ error: 'forbidden' });
  db.setLineStyle(req.params.line, style);
  emitState();
  res.json({ ok: true });
});

app.post('/api/lines/:line/status', async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status wajib' });
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (!canEditLine(user, req.params.line)) return res.status(403).json({ error: 'forbidden' });
  db.setLineStatus(req.params.line, status);
  emitState();
  res.json({ ok: true });
});

app.get('/api/mysql/export.sql', async (req, res) => {
  const live = await db.getStateLive();
  const sql = exportMySQLSQL(live, {
    database: req.query.db || 'button_db',
    engine: 'InnoDB',
    charset: 'utf8mb4'
  });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(sql);
});

app.post('/api/machines/upsert', async (req, res) => {
  const { line, machine, job, good, reject, status } = req.body || {};
  if (!line || !machine) return res.status(400).json({ error: 'line dan machine wajib' });
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (!canEditLine(user, line)) return res.status(403).json({ error: 'forbidden' });
  db.upsertMachine({ line, machine, job, good, reject, status });
  emitState();
  res.json({ ok: true });
});

app.post('/api/machines/increment', async (req, res) => {
  const { line, machine, goodDelta, rejectDelta, status } = req.body || {};
  if (!line || !machine) return res.status(400).json({ error: 'line dan machine wajib' });
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (!canEditLine(user, line)) return res.status(403).json({ error: 'forbidden' });
  db.incrementMachine({ line, machine, goodDelta, rejectDelta, status });
  emitState();
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Operator Counter Dashboard server running on http://localhost:${PORT}`);
});

async function getAuthUser(req, res) {
  const hdr = String(req.headers.authorization || '').trim();
  const tok = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7).trim() : null;
  const payload = auth.verifyToken(tok, SECRET);
  if (!payload) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const user = await auth.getUserByIdAsync(payload.userId);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return null; }
  return user;
}

function canEditLine(user, line) {
  if (user.role === 'tech_admin') return true;
  if (user.role === 'line_admin') return Array.isArray(user.lines) && user.lines.includes(line);
  return false;
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const who = String(username || '').trim();
  const u = await auth.getUserByUsernameAsync(who);
  if (!u) { console.warn('login_fail_user_not_found', { username: who }); return res.status(401).json({ error: 'user_not_found' }); }
  const ok = String(password || '') === String(u.password || '');
  if (!ok) { console.warn('login_fail_pw_mismatch', { username: who, salt_len: String(u.salt || '').length, hash_prefix: String(u.hash || '').slice(0, 7) }); return res.status(401).json({ error: 'password_mismatch' }); }
  const token = auth.signToken({ userId: u.id, role: u.role }, SECRET);
  res.json({ ok: true, token, user: { id: u.id, username: u.username, role: u.role, lines: u.lines } });
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  res.json({ id: user.id, username: user.username, role: user.role, lines: user.lines });
});

app.get('/api/debug/master_users', async (req, res) => {
  try {
    await db.ensureButtonSchema();
    const pool = db.getButtonPool();
    const [rows] = await pool.query('SELECT id, username, role, lines FROM master_users');
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/debug/hash', async (req, res) => {
  res.status(410).json({ error: 'disabled' });
});

app.post('/api/debug/bcrypt-hash', async (req, res) => {
  res.status(410).json({ error: 'disabled' });
});

app.post('/api/debug/upsert-user', async (req, res) => {
  try {
    const { username, password, role, lines } = req.body || {};
    if (!username || !password || !role) return res.status(400).json({ error: 'username_password_role_wajib' });
    await db.ensureButtonSchema();
    const pool = db.getButtonPool();
    const lineStr = Array.isArray(lines) ? lines.join(',') : (typeof lines === 'string' ? lines : '');
    await pool.execute(
      'INSERT INTO master_users (username, role, password, lines) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role), password=VALUES(password), lines=VALUES(lines)',
      [String(username), String(role), String(password), lineStr]
    );
    const [rows] = await pool.execute('SELECT id, username, role, lines FROM master_users WHERE username = ?', [String(username)]);
    const u = rows && rows[0] ? rows[0] : null;
    res.json({ ok: true, user: u });
  } catch {
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/debug/verify-user', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username_password_wajib' });
    await db.ensureButtonSchema();
    const pool = db.getButtonPool();
    const [rows] = await pool.execute('SELECT id, username, role, password, lines FROM master_users WHERE username = ?', [String(username)]);
    if (!rows.length) return res.status(404).json({ error: 'user_tidak_ada' });
    const u = rows[0];
    const ok = String(password) === String(u.password || '');
    res.json({ ok, role: u.role, lines: u.lines });
  } catch {
    res.status(500).json({ error: 'db_error' });
  }
});

app.get('/api/debug/user/:username', async (req, res) => {
  try {
    const uname = String(req.params.username || '').trim();
    const u = await auth.getUserByUsernameAsync(uname);
    if (!u) return res.status(404).json({ error: 'user_tidak_ada' });
    res.json({ id: u.id, username: u.username, role: u.role, lines: u.lines });
  } catch {
    res.status(500).json({ error: 'db_error' });
  }
});

app.get('/api/master/kategori', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getKategoriMaster();
  res.json({ data: rows });
});

app.post('/api/master/kategori', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name wajib' });
  const row = await db.createKategoriMaster({ name });
  res.json({ ok: true, data: row });
});

app.put('/api/master/kategori/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name wajib' });
  await db.updateKategoriMaster(req.params.id, { name });
  res.json({ ok: true });
});

app.delete('/api/master/kategori/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteKategoriMaster(req.params.id);
  res.json({ ok: true });
});

app.get('/api/master/jenis', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getJenisMesinMaster();
  res.json({ data: rows });
});

app.post('/api/master/jenis', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name wajib' });
  const row = await db.createJenisMesinMaster({ name });
  res.json({ ok: true, data: row });
});

app.put('/api/master/jenis/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name wajib' });
  await db.updateJenisMesinMaster(req.params.id, { name });
  res.json({ ok: true });
});

app.delete('/api/master/jenis/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteJenisMesinMaster(req.params.id);
  res.json({ ok: true });
});

app.get('/api/master/merk', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getMerkMaster();
  res.json({ data: rows });
});

app.post('/api/master/merk', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { name, id_jnsmesin } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name wajib' });
  const row = await db.createMerkMaster({ name, id_jnsmesin });
  res.json({ ok: true, data: row });
});

app.put('/api/master/merk/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { name, id_jnsmesin } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name wajib' });
  await db.updateMerkMaster(req.params.id, { name, id_jnsmesin });
  res.json({ ok: true });
});

app.delete('/api/master/merk/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteMerkMaster(req.params.id);
  res.json({ ok: true });
});

// Master Line (line_db)
app.get('/api/master/line', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getMasterLine();
  res.json({ data: rows });
});

app.post('/api/master/line', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { nama_line } = req.body || {};
  if (!nama_line) return res.status(400).json({ error: 'nama_line wajib' });
  const row = await db.createMasterLine({ nama_line });
  res.json({ ok: true, data: row });
});

app.put('/api/master/line/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { nama_line } = req.body || {};
  if (!nama_line) return res.status(400).json({ error: 'nama_line wajib' });
  await db.updateMasterLine(req.params.id, { nama_line });
  res.json({ ok: true });
});

app.delete('/api/master/line/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteMasterLine(req.params.id);
  res.json({ ok: true });
});
