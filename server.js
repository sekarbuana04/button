const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');
const auth = require('./auth');
const { exportMySQLSQL } = require('./db_export');
const mqtt = require('mqtt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const IOT_HTTP_PORT = Number(process.env.IOT_HTTP_PORT || 5000);
const SIMULATE = (process.env.SIMULATE || 'false').toLowerCase() === 'true';
const SECRET = process.env.SESSION_SECRET || '';
const ENABLE_DEBUG = (process.env.DEBUG_API || 'false').toLowerCase() === 'true';
const IOT_HTTP_KEY = process.env.IOT_HTTP_KEY || '';
const IOT_MQTT_URL = process.env.IOT_MQTT_URL || '';
const IOT_MQTT_TOPIC = process.env.IOT_MQTT_TOPIC || 'factory/+/rx/+/tx/+/event';
const IOT_MQTT_HEARTBEAT_TOPIC = process.env.IOT_MQTT_HEARTBEAT_TOPIC || 'factory/+/rx/+/heartbeat';
const IOT_MQTT_SITE = process.env.IOT_MQTT_SITE || process.env.SITE || 'site1';
const IOT_MQTT_PING_TPL = process.env.IOT_MQTT_PING_TPL || 'factory/{site}/rx/{mac}/ping';
const IOT_MQTT_TX_PING_TPL = process.env.IOT_MQTT_TX_PING_TPL || 'factory/{site}/tx/{tx}/ping';
const IOT_MQTT_TX_HEARTBEAT_TPL = process.env.IOT_MQTT_TX_HEARTBEAT_TPL || 'factory/{site}/tx/{tx}/heartbeat';
const IOT_MQTT_TX_HEARTBEAT_WILDCARD = process.env.IOT_MQTT_TX_HEARTBEAT_WILDCARD || 'factory/+/tx/+/heartbeat';
const IOT_HTTP_IP_WHITELIST = (process.env.IOT_HTTP_IP_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
const IOT_HTTP_RATE_LIMIT_PER_MIN = Number(process.env.IOT_HTTP_RATE_LIMIT_PER_MIN || 200);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use('/vendor/bootstrap', express.static(path.join(__dirname, 'node_modules', 'bootstrap', 'dist')));
app.use('/vendor/bootstrap-icons', express.static(path.join(__dirname, 'node_modules', 'bootstrap-icons')));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

const iotApp = express();
const iotServer = http.createServer(iotApp);
iotApp.use(express.json());

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
if (IOT_HTTP_PORT && IOT_HTTP_PORT !== PORT) {
  iotServer.listen(IOT_HTTP_PORT, () => {
    console.log(`IoT HTTP listener running on http://localhost:${IOT_HTTP_PORT}`);
  });
}

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
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
  try {
    await db.ensureButtonSchema();
    const pool = db.getButtonPool();
    const [rows] = await pool.query('SELECT * FROM master_users');
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: String(e && e.message || '') });
  }
});

app.post('/api/debug/drop-machine-tx-transmitters', async (req, res) => {
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const result = await db.dropMachineTxAndTransmitters();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: String(e && e.message || '') });
  }
});


app.get('/api/debug/pingdb', async (req, res) => {
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
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
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
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
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
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
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
  try {
    const u = await auth.getUserByUsernameAsync(String(req.params.username || '').trim());
    if (!u || u.error === 'db_error') return res.status(404).json({ error: 'user_not_found' });
    res.json(u);
  } catch {
    res.status(500).json({ error: 'db_error' });
  }
});

// removed: legacy debug hash endpoints

app.post('/api/debug/upsert-user', async (req, res) => {
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
  try {
    const { username, password, role, lines } = req.body || {};
    if (!username || !password || !role) return res.status(400).json({ error: 'username_password_role_wajib' });
    await db.ensureButtonSchema();
    const pool = db.getButtonPool();
    const dbname = process.env.BUTTON_DB_NAME || 'button_db';
    const [colsRows] = await pool.query('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = "master_users"', [dbname]);
    const cols = Array.isArray(colsRows) ? colsRows.map(r => r.COLUMN_NAME || r.column_name).filter(Boolean) : [];
    const has = (c) => cols.includes(c);
    const [ex] = await pool.execute('SELECT id FROM master_users WHERE username = ? LIMIT 1', [String(username)]);
    const exists = Array.isArray(ex) && ex[0];
    const lineStr = Array.isArray(lines) ? lines.join(',') : (typeof lines === 'string' ? lines : '');
    if (exists) {
      const parts = [];
      const args = [];
      if (has('role')) { parts.push('role = ?'); args.push(String(role)); }
      if (has('password')) { parts.push('password = ?'); args.push(String(password)); }
      if (has('lines')) { parts.push('lines = ?'); args.push(lineStr); }
      if (has('nama') && !has('lines')) { parts.push('nama = ?'); args.push(String(username)); }
      if (!parts.length) return res.status(500).json({ error: 'db_error' });
      args.push(String(username));
      await pool.execute(`UPDATE master_users SET ${parts.join(', ')} WHERE username = ?`, args);
    } else {
      const insCols = [];
      const placeholders = [];
      const args = [];
      if (has('username')) { insCols.push('username'); placeholders.push('?'); args.push(String(username)); }
      if (has('role')) { insCols.push('role'); placeholders.push('?'); args.push(String(role)); }
      if (has('password')) { insCols.push('password'); placeholders.push('?'); args.push(String(password)); }
      if (has('lines')) { insCols.push('lines'); placeholders.push('?'); args.push(lineStr); }
      if (has('nama') && !has('lines')) { insCols.push('nama'); placeholders.push('?'); args.push(String(username)); }
      if (!insCols.length) return res.status(500).json({ error: 'db_error' });
      await pool.execute(`INSERT INTO master_users (${insCols.join(',')}) VALUES (${placeholders.join(',')})`, args);
    }
    const [rows] = await pool.execute('SELECT * FROM master_users WHERE username = ?', [String(username)]);
    const u = rows && rows[0] ? rows[0] : null;
    res.json({ ok: true, user: u });
  } catch {
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/debug/verify-user', async (req, res) => {
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
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
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
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


// removed: transmitters listing endpoint


// removed: setup IoT tables inside button_db


// removed: IoT MQTT and HTTP endpoints

app.get('/api/master/proses_produksi', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getProsesProduksi();
  res.json({ data: rows });
});

app.put('/api/master/proses_produksi/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { nama } = req.body || {};
  if (!nama) return res.status(400).json({ error: 'nama wajib' });
  await db.updateProsesProduksi(req.params.id, { nama });
  res.json({ ok: true });
});

app.delete('/api/master/proses_produksi/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteProsesProduksi(req.params.id);
  res.json({ ok: true });
});

// Master Line (line_db)
app.get('/api/master/line', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getMasterLine();
  res.json({ data: rows });
});

app.get('/api/master/style', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getMasterStyles();
  res.json({ data: rows });
});

app.put('/api/master/style/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { style_nama } = req.body || {};
  if (!style_nama) return res.status(400).json({ error: 'style_nama wajib' });
  await db.updateMasterStyle(req.params.id, { style_nama });
  res.json({ ok: true });
});

app.delete('/api/master/style/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteMasterStyle(req.params.id);
  res.json({ ok: true });
});

// Master Color
app.get('/api/master/color', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const rows = await db.getMasterColors();
  res.json({ data: rows });
});

app.post('/api/master/color', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { color } = req.body || {};
  if (!color) return res.status(400).json({ error: 'color_wajib' });
  const row = await db.createMasterColor({ color });
  res.json({ ok: true, data: row });
});

app.put('/api/master/color/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const { color } = req.body || {};
  if (!color) return res.status(400).json({ error: 'color_wajib' });
  await db.updateMasterColor(req.params.id, { color });
  res.json({ ok: true });
});

app.delete('/api/master/color/:id', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  await db.deleteMasterColor(req.params.id);
  res.json({ ok: true });
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

app.get('/api/transmitters', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  try {
    const thr = Number(req.query.threshold_ms || 10000) || 10000;
    await db.ensureIotSchema();
    const pool = db.getIotPool();
    if (!pool) return res.json({ data: [] });
    const [rows] = await pool.query(
      'SELECT s.tx, COALESCE(NULLIF(t.name, ""), s.tx) AS name, s.updated_at AS last_seen, s.output, s.reject, s.output_total, s.reject_total, t.receiver_id, r.mac_address ' +
      'FROM summary s LEFT JOIN transmitters t ON t.transmitter_id = s.tx ' +
      'LEFT JOIN receivers r ON r.receiver_id = t.receiver_id ' +
      'ORDER BY s.tx ASC'
    );
    const now = Date.now();
    const data = (Array.isArray(rows) ? rows : []).map(r => {
      const lastSeen = r && r.last_seen ? new Date(r.last_seen).getTime() : null;
      const connected = lastSeen != null && (now - lastSeen) <= thr;
      return { ...r, connected };
    });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

app.get('/api/transmitters/available', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  try {
    const thr = Number(req.query.threshold_ms || 10000) || 10000;
    await db.ensureIotSchema();
    const pool = db.getIotPool();
    if (!pool) return res.json({ data: [] });
    const [rows] = await pool.query(
      'SELECT s.tx, COALESCE(NULLIF(t.name, ""), s.tx) AS name, s.updated_at AS last_seen, s.output, s.reject, s.output_total, s.reject_total, t.receiver_id, r.mac_address ' +
      'FROM summary s LEFT JOIN transmitters t ON t.transmitter_id = s.tx ' +
      'LEFT JOIN receivers r ON r.receiver_id = t.receiver_id ' +
      'ORDER BY s.tx ASC'
    );
    const usedRows = await db.getMachineTxAssignments();
    const used = new Set((Array.isArray(usedRows) ? usedRows : []).map(r => String(r && r.tx || '')).filter(Boolean));
    const now = Date.now();
    const data = (Array.isArray(rows) ? rows : [])
      .filter(r => r && r.tx && !used.has(String(r.tx)))
      .map(r => {
        const lastSeen = r && r.last_seen ? new Date(r.last_seen).getTime() : null;
        const connected = lastSeen != null && (now - lastSeen) <= thr;
        return { ...r, connected };
      });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

app.post('/api/transmitters/:tx/unbind', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const tx = String(req.params.tx || '').trim();
  if (!tx) return res.status(400).json({ error: 'tx_wajib' });
  try {
    const result = await db.iotUnbindTransmitter(tx);
    if (result && result.ok) return res.json({ ok: true });
    return res.status(400).json({ ok: false });
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

app.post('/api/transmitters/:tx/ping', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const tx = String(req.params.tx || '').trim();
  if (!tx) return res.status(400).json({ error: 'tx_wajib' });
  if (!mqttClient) return res.status(503).json({ error: 'mqtt_unavailable' });
  try {
    const pingTopic = String(IOT_MQTT_TX_PING_TPL).replace('{site}', String(IOT_MQTT_SITE)).replace('{tx}', tx);
    const expectHb = String(IOT_MQTT_TX_HEARTBEAT_TPL).replace('{site}', String(IOT_MQTT_SITE)).replace('{tx}', tx);
    let resolved = false;
    const timeoutMs = Math.max(500, Number(process.env.IOT_PING_TIMEOUT_MS || 2000) || 2000);
    const onMsg = async (topic) => {
      if (resolved) return;
      if (topic === expectHb) {
        resolved = true;
        try { mqttClient.off('message', onListener); } catch {}
        res.json({ ok: true, ack: true });
      }
    };
    const onListener = (topic) => { onMsg(topic); };
    try { mqttClient.on('message', onListener); } catch {}
    await mqttClient.publish(pingTopic, JSON.stringify({ ts: Date.now() }), { qos: 1 });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { mqttClient.off('message', onListener); } catch {}
      res.status(504).json({ error: 'timeout', message: 'ping_timeout' });
    }, timeoutMs);
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

app.put('/api/transmitters/:tx', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const tx = String(req.params.tx || '').trim();
  const { name } = req.body || {};
  if (!tx) return res.status(400).json({ error: 'tx_wajib' });
  if (!name) return res.status(400).json({ error: 'name_wajib' });
  try {
    const result = await db.iotUpdateTransmitterName(tx, name);
    if (result && result.ok) return res.json({ ok: true });
    return res.status(400).json({ ok: false });
  } catch (e) { res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') }); }
});

app.delete('/api/transmitters/:tx', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  if (user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const tx = String(req.params.tx || '').trim();
  if (!tx) return res.status(400).json({ error: 'tx_wajib' });
  try {
    const result = await db.iotDeleteTransmitter(tx);
    if (result && result.ok) return res.json({ ok: true });
    return res.status(400).json({ ok: false });
  } catch (e) { res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') }); }
});

app.get('/api/machine/tx/:line', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const line = req.params.line;
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const data = await db.getMachineTxAssignments(line);
  res.json({ data });
});

app.get('/api/transmitters/used', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  try {
    const rows = await db.getMachineTxAssignments();
    const used = Array.from(new Set((Array.isArray(rows) ? rows : []).map(r => String(r && r.tx || '')).filter(Boolean)));
    res.json({ data: used });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: String(e && e.message || '') });
  }
});

app.post('/api/machine/tx', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { line, machine, tx } = req.body || {};
  if (!line || !machine || !tx) return res.status(400).json({ error: 'line_machine_tx_wajib' });
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const result = await db.assignMachineTx({ line, machine, tx });
  if (result && result.ok) { await emitState(); return res.json({ ok: true }); }
  if (result && result.error === 'tx_in_use') return res.status(409).json({ error: 'tx_in_use' });
  if (result && result.error === 'tx_not_found') return res.status(404).json({ error: 'tx_not_found' });
  return res.status(400).json({ ok: false, error: 'assign_failed' });
});

app.delete('/api/machine/tx', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { line, machine } = req.body || {};
  if (!line || !machine) return res.status(400).json({ error: 'line_machine_wajib' });
  if (!canEditLine(user, line) && user.role !== 'tech_admin') return res.status(403).json({ error: 'forbidden' });
  const result = await db.unassignMachineTx({ line, machine });
  if (result && result.ok) { await emitState(); return res.json({ ok: true }); }
  return res.status(400).json({ ok: false, error: 'unassign_failed' });
});

// Debug endpoint untuk memeriksa style_order di button_db
app.get('/api/debug/style-order/:line', async (req, res) => {
  if (!ENABLE_DEBUG) return res.status(404).json({ error: 'not_found' });
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
  const { line, processName, machineType, qty, target } = req.body || {};
  if (!line || !processName || !machineType) return res.status(400).json({ error: 'line_process_machine_wajib' });
  if (!canEditLine(user, line)) return res.status(403).json({ error: 'forbidden' });
  await db.addProcessMachines({ line, processName, machineType, qty, target });
  await emitState();
  res.json({ ok: true });
});

app.delete('/api/process/machines', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const { line, processName, machineType } = req.body || {};
  if (!line || !processName) return res.status(400).json({ error: 'line_process_wajib' });
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

app.post('/api/iot/event', async (req, res) => {
  try {
    const { receiver_mac, mac, tx, type, cmd, output, reject, value_output, value_reject, event_id, schema_version } = req.body || {};
    const t = String(type || cmd || '').trim().toLowerCase();
    if (!tx || !t || !['output', 'reject', 'reset'].includes(t)) return res.status(400).json({ error: 'payload_invalid' });
    const token = String(req.headers['x-auth-token'] || req.headers['x-iot-key'] || '');
    if (IOT_HTTP_KEY && token !== String(IOT_HTTP_KEY)) return res.status(401).json({ error: 'unauthorized' });
    const payload = { output, reject, value_output, value_reject, event_id, schema_version: schema_version || 1 };
    const sum = await db.iotHandleEvent(tx, receiver_mac || mac || '', t, payload);
    await emitState();
    res.json({ ok: true, summary: sum });
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

app.get('/api/iot/status', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const thr = Number(req.query.threshold_ms || 10000) || 10000;
  try {
    const data = await db.iotGetStatus(thr);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

app.get('/api/iot/logs', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200) || 200));
  try {
    const data = await db.iotGetLogs(limit);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

function clientIp(req) {
  const xfwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xfwd || req.ip || (req.connection && req.connection.remoteAddress) || '';
}
const rateMap = new Map();
function allowRate(key) {
  const now = Date.now();
  const k = String(key || '').trim() || 'unknown';
  const entry = rateMap.get(k) || { start: now, count: 0 };
  if (now - entry.start >= 60 * 1000) { entry.start = now; entry.count = 0; }
  if (entry.count >= IOT_HTTP_RATE_LIMIT_PER_MIN) return false;
  entry.count++;
  rateMap.set(k, entry);
  return true;
}
function normalizeIotEventType(typeOrCmd) {
  const raw = typeOrCmd == null ? '' : String(typeOrCmd).trim();
  const up = raw.toUpperCase();
  if (!up) return '';
  if (up === '1' || up === '01' || up === 'OUTPUT' || up === 'ACCEPT') return 'output';
  if (up === '2' || up === '02' || up === 'REJECT') return 'reject';
  if (up === '3' || up === '03' || up === 'RESET') return 'reset';
  const low = raw.toLowerCase();
  if (low === 'output' || low === 'reject' || low === 'reset') return low;
  return '';
}
async function handleIotHttp(req, res) {
  try {
    const ip = clientIp(req);
    if (IOT_HTTP_IP_WHITELIST.length) {
      const ok = IOT_HTTP_IP_WHITELIST.includes(ip);
      if (!ok) return res.status(401).json({ error: 'ip_not_allowed' });
    }
    const { schema_version, receiver_mac, mac, tx, type, cmd, output, reject, value_output, value_reject, event_id } = req.body || {};
    const t = normalizeIotEventType(type || cmd || '');
    if (!tx || !t) return res.status(400).json({ error: 'payload_invalid' });
    const token = String(req.headers['x-auth-token'] || req.headers['x-iot-key'] || '');
    if (IOT_HTTP_KEY && token !== String(IOT_HTTP_KEY)) return res.status(401).json({ error: 'unauthorized' });
    const rateKey = receiver_mac || mac || ip;
    if (!allowRate(rateKey)) return res.status(429).json({ error: 'rate_limit' });
    const payload = {
      output,
      reject,
      value_output,
      value_reject,
      event_id,
      mac: receiver_mac || mac || null,
      schema_version: schema_version || 1
    };
    const sum = await db.iotHandleEvent(tx, receiver_mac || mac || '', t, payload);
    await emitState();
    res.json({ ok: true, summary: sum });
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
}
app.post('/data', handleIotHttp);
iotApp.post('/data', handleIotHttp);
app.post('/api/receivers/heartbeat', async (req, res) => {
  try {
    const { mac_address } = req.body || {};
    if (!mac_address) return res.status(400).json({ error: 'mac_wajib' });
    await db.iotUpdateReceiverLastSeen(mac_address);
    await emitState();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

app.put('/api/receivers/:mac', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const mac = req.params.mac;
  const { name } = req.body || {};
  if (!mac) return res.status(400).json({ error: 'mac_wajib' });
  await db.iotUpdateReceiverName(mac, name);
  await emitState();
  res.json({ ok: true });
});

app.delete('/api/receivers/:mac', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const mac = req.params.mac;
  if (!mac) return res.status(400).json({ error: 'mac_wajib' });
  await db.iotDeleteReceiver(mac);
  await emitState();
  res.json({ ok: true });
});

app.post('/api/receivers/:mac/ping', async (req, res) => {
  const user = await getAuthUser(req, res);
  if (!user) return;
  const mac = String(req.params.mac || '').trim();
  if (!mac) return res.status(400).json({ error: 'mac_wajib' });
  if (!mqttClient) return res.status(503).json({ error: 'mqtt_unavailable' });
  try {
    const pingTopic = String(IOT_MQTT_PING_TPL).replace('{site}', String(IOT_MQTT_SITE)).replace('{mac}', mac);
    const expectHb = `factory/${String(IOT_MQTT_SITE)}/rx/${mac}/heartbeat`;
    let resolved = false;
    const timeoutMs = Math.max(500, Number(process.env.IOT_PING_TIMEOUT_MS || 2000) || 2000);
    const onMsg = async (topic) => {
      if (resolved) return;
      if (topic === expectHb) {
        resolved = true;
        try { mqttClient.off('message', onListener); } catch {}
        res.json({ ok: true, ack: true });
      }
    };
    const onListener = (topic) => { onMsg(topic); };
    try { mqttClient.on('message', onListener); } catch {}
    await mqttClient.publish(pingTopic, JSON.stringify({ ts: Date.now() }), { qos: 1 });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { mqttClient.off('message', onListener); } catch {}
      res.status(504).json({ error: 'timeout', message: 'ping_timeout' });
    }, timeoutMs);
  } catch (e) {
    res.status(500).json({ error: 'iot_error', message: String(e && e.message || '') });
  }
});

let mqttClient = null;
if (IOT_MQTT_URL) {
  mqttClient = mqtt.connect(IOT_MQTT_URL, {
    username: process.env.IOT_MQTT_USERNAME || undefined,
    password: process.env.IOT_MQTT_PASSWORD || undefined,
    reconnectPeriod: 3000,
    clean: false,
    clientId: `${String(IOT_MQTT_SITE || 'site')}-dashboard-${Math.random().toString(16).slice(2)}`
  });
  const iotMetrics = { http_ok: 0, http_err: 0, mqtt_ok: 0, mqtt_err: 0 };
  app.get('/api/iot/health', async (req, res) => {
    const user = await getAuthUser(req, res);
    if (!user) return;
    res.json({ metrics: iotMetrics });
  });
  mqttClient.on('connect', () => {
    try { mqttClient.subscribe(IOT_MQTT_TOPIC, { qos: 1 }); } catch {}
    try { mqttClient.subscribe(IOT_MQTT_HEARTBEAT_TOPIC, { qos: 1 }); } catch {}
    try { mqttClient.subscribe(IOT_MQTT_TX_HEARTBEAT_WILDCARD, { qos: 1 }); } catch {}
  });
  function parseEventTopic(topic) {
    // factory/<site>/rx/<MAC>/tx/<TX_ID>/event
    const parts = String(topic || '').split('/');
    const idxRx = parts.indexOf('rx');
    const idxTx = parts.indexOf('tx');
    const mac = (idxRx >= 0 && parts[idxRx + 1]) ? parts[idxRx + 1] : null;
    const tx = (idxTx >= 0 && parts[idxTx + 1]) ? parts[idxTx + 1] : null;
    return { mac, tx };
  }
  mqttClient.on('message', async (topic, message) => {
    try {
      const obj = JSON.parse(message.toString());
      let { receiver_mac, mac, tx, type, cmd, output, reject, value_output, value_reject, event_id, schema_version } = obj || {};
      if (topic.includes('/event')) {
        if (!receiver_mac || !tx) {
          const parsed = parseEventTopic(topic);
          receiver_mac = receiver_mac || parsed.mac;
          tx = tx || parsed.tx;
        }
      } else if (topic.includes('/heartbeat')) {
        const parts = String(topic || '').split('/');
        const idxRx = parts.indexOf('rx');
        const mac = (idxRx >= 0 && parts[idxRx + 1]) ? parts[idxRx + 1] : null;
        if (mac) await db.iotUpdateReceiverLastSeen(mac);
        iotMetrics.mqtt_ok++;
        return;
      }
      const t = String(type || cmd || '').trim().toLowerCase();
      if (!tx || !t || !['output', 'reject', 'reset'].includes(t)) return;
      const payload = { output, reject, value_output, value_reject, event_id, schema_version: schema_version || 1 };
      await db.iotHandleEvent(tx, receiver_mac || mac || '', t, payload);
      await emitState();
      iotMetrics.mqtt_ok++;
    } catch {
      try { iotMetrics.mqtt_err++; } catch {}
    }
  });
}
