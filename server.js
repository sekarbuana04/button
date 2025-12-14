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
const SECRET = process.env.SESSION_SECRET || '';

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
  if (u && u.error === 'db_error') { console.error('login_db_error', { username: who, message: u.message }); return res.status(500).json({ error: 'db_error' }); }
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
    const [rows] = await pool.query('SELECT * FROM master_users');
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: String(e && e.message || '') });
  }
});

app.get('/api/debug/pingdb', async (req, res) => {
  try {
    await db.ensureButtonSchema();
    const pool = db.getButtonPool();
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: String(e && e.message || '') });
  }
});

app.get('/api/debug/columns', async (req, res) => {
  try {
    await db.ensureButtonSchema();
    const pool = db.getButtonPool();
    const dbname = process.env.BUTTON_DB_NAME || 'button_db';
    const [rows] = await pool.query('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = "master_users"', [dbname]);
    res.json({ data: rows.map(r => r.COLUMN_NAME || r.column_name) });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: String(e && e.message || '') });
  }
});

app.get('/api/debug/table-exists/:name', async (req, res) => {
  try {
    await db.ensureButtonSchema();
    const pool = db.getButtonPool();
    const dbname = process.env.BUTTON_DB_NAME || 'button_db';
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'table_name_wajib' });
    const [rows] = await pool.query('SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [dbname, name]);
    const c = (rows && rows[0] && (rows[0].c || rows[0].C)) || 0;
    res.json({ table: name, exists: c > 0 });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: String(e && e.message || '') });
  }
});

app.get('/api/debug/getuser/:username', async (req, res) => {
  try {
    const u = await auth.getUserByUsernameAsync(String(req.params.username || '').trim());
    if (!u || u.error === 'db_error') return res.status(404).json({ error: 'user_not_found' });
    res.json(u);
  } catch {
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

app.get('/api/master/transmitters', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getTransmitters();
  res.json({ data: rows });
});

app.post('/api/master/transmitters', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { name, device_id, status } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name_wajib' });
  const row = await db.createTransmitter({ name, device_id, status });
  res.json({ ok: true, data: row });
});

app.put('/api/master/transmitters/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { name, device_id, status } = req.body || {};
  await db.updateTransmitter(req.params.id, { name, device_id, status });
  res.json({ ok: true });
});

app.delete('/api/master/transmitters/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteTransmitter(req.params.id);
  res.json({ ok: true });
});

app.get('/api/lines/:line/transmitters', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const line = req.params.line;
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const map = await db.getMachineTxMapForLine(line);
  const list = await db.getTransmitters();
  res.json({ line, map, transmitters: list });
});

app.post('/api/lines/:line/machines/:machine/transmitter', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const line = req.params.line;
  const machine = req.params.machine;
  if (!line || !machine) return res.status(400).json({ error: 'line_machine_wajib' });
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { tx_id } = req.body || {};
  if (tx_id != null) {
    const map = await db.getMachineTxMapForLine(line);
    for (const k of Object.keys(map)) {
      const v = map[k];
      if (k !== machine && v != null && Number(v) === Number(tx_id)) {
        return res.status(409).json({ error: 'tx_in_use', machine: k });
      }
    }
  }
  await db.setMachineTransmitter(machine, tx_id || null);
  res.json({ ok: true });
});

app.get('/api/master/proses_produksi', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getProsesProduksi();
  res.json({ data: rows });
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
  await db.refreshLinesFromMaster();
  await emitState();
  res.json({ ok: true, data: row });
});

// Style Order endpoints
app.post('/api/style/order', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { category, type, processes, line } = req.body || {};
  if (!line) return res.status(400).json({ error: 'line wajib' });
  const result = await db.saveStyleOrder({ line, category, type, processes });
  await emitState();
  if (result && result.ok === true) return res.json({ ok: true });
  return res.status(400).json({ ok: false, error: 'gagal_menyimpan_order_style' });
});

app.post('/api/style/process', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { line, name } = req.body || {};
  if (!line || !name) return res.status(400).json({ error: 'line_name_wajib' });
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const result = await db.addStyleProcess({ line, name });
  await emitState();
  res.json(result);
});

app.delete('/api/style/process', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { line, name } = req.body || {};
  if (!line || !name) return res.status(400).json({ error: 'line_name_wajib' });
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const result = await db.deleteStyleProcess({ line, name });
  await emitState();
  res.json(result);
});

app.put('/api/style/process', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { line, oldName, newName } = req.body || {};
  if (!line || !oldName || !newName) return res.status(400).json({ error: 'line_old_new_wajib' });
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const result = await db.renameStyleProcess({ line, oldName, newName });
  await emitState();
  res.json(result);
});

app.get('/api/style/order/:line', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const line = req.params.line;
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const data = await db.getStyleOrderByLine(line);
  res.json(data);
});

// Debug endpoint untuk memeriksa style_order di button_db
app.get('/api/debug/style-order/:line', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const line = req.params.line;
  try {
    const rows = await db.getMasterLine();
    const found = (rows || []).find(r => String(r.nama_line) === String(line));
    const idLine = found ? found.id_line : null;
    let styleRow = null;
    if (idLine != null) {
      const pool = db.getButtonPool();
      const [so] = await pool.query('SELECT id_style, style_nama, id_line FROM style_order WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [idLine]);
      styleRow = Array.isArray(so) && so[0] ? so[0] : null;
    }
    res.json({ id_line: idLine, style_row: styleRow });
  } catch (e) { res.status(500).json({ error: 'debug_error', message: String(e && e.message || e) }); }
});

// Master Proses: add machines per process
app.post('/api/process/machines', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { line, processName, machineType, qty } = req.body || {};
  if (!line || !processName || !machineType) return res.status(400).json({ error: 'line_process_machine_wajib' });
  if (!canEditLine(user, line)) return res.status(403).json({ error: 'forbidden' });
  await db.addProcessMachines({ line, processName, machineType, qty });
  await emitState();
  res.json({ ok: true });
});

app.delete('/api/process/machines', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { line, processName, machineType } = req.body || {};
  if (!line || !processName || !machineType) return res.status(400).json({ error: 'line_process_machine_wajib' });
  if (!canEditLine(user, line)) return res.status(403).json({ error: 'forbidden' });
  const result = await db.deleteProcessMachines({ line, processName, machineType });
  await emitState();
  res.json(result);
});

// Master Order summary
app.get('/api/master/order', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const data = await db.getMasterOrderSummary();
  res.json({ data });
});

app.delete('/api/master/order', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { line } = req.body || {};
  if (!line) return res.status(400).json({ error: 'line_wajib' });
  const result = await db.deleteMasterOrderForLine(line);
  await emitState();
  res.json(result);
});

// Admin: migrasi legacy tables ke master dan drop
app.post('/api/admin/migrate-legacy', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const result = await db.migrateLegacyTables();
    await db.refreshLinesFromMaster();
    await emitState();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: String(e && e.message || '') });
  }
});

app.put('/api/master/line/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { nama_line } = req.body || {};
  if (!nama_line) return res.status(400).json({ error: 'nama_line wajib' });
  await db.updateMasterLine(req.params.id, { nama_line });
  await db.refreshLinesFromMaster();
  await emitState();
  res.json({ ok: true });
});

app.delete('/api/master/line/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteMasterLine(req.params.id);
  await db.refreshLinesFromMaster();
  await emitState();
  res.json({ ok: true });
});
