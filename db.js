const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'production.json');

const jobNames = [
  'Jahit Kerah', 'Jahit Kantong', 'Jahit Lengan', 'Pasang Kancing', 'Obras Tepi', 'Press Akhir',
  'Jahit Pinggang', 'Jahit Sisi', 'Pasang Resleting', 'Jahit Manset', 'Jahit Kerut', 'Finishing',
  'QC Visual', 'QC Ukuran', 'QC Fungsional', 'Packing', 'Fold & Tag', 'Labeling',
  'Jahit Bahu', 'Jahit Belahan', 'Jahit Pundak', 'Jahit Hem', 'Ratakan Jahitan', 'Setrika Bagian',
  'Hitung Output', 'Rework Minor', 'Rework Mayor', 'Pasang Aksesoris', 'Jahit Detail', 'Jahit Lapisan',
  'Top Stitch', 'Under Stitch', 'Tack Stitch', 'Bartack', 'Lock Stitch', 'Zigzag'
];

const styleList = ['Kemeja','Celana','Rok','Sweater','Jaket','Blouse','Kaos','Hoodie','Gamis'];
const styleJobs = {
  Kemeja: ['Potong Pola','Jahit Kerah','Jahit Manset','Jahit Bahu','Jahit Sisi','Pasang Kancing','Obras Tepi','Setrika Bagian','Top Stitch','QC Visual','QC Ukuran','Finishing'],
  Celana: ['Potong Pola','Jahit Pinggang','Jahit Saku','Pasang Resleting','Jahit Sisi','Jahit Hem','Bartack','Lock Stitch','Setrika Bagian','QC Visual','QC Ukuran','Finishing'],
  Rok: ['Potong Pola','Jahit Kerut','Jahit Pinggang','Jahit Sisi','Jahit Hem','Obras Tepi','Top Stitch','Under Stitch','Setrika Bagian','QC Visual','QC Ukuran','Finishing'],
  Sweater: ['Potong Kain','Jahit Rib Leher','Jahit Lengan','Jahit Badan','Overlock Keliling','Top Stitch','Setrika Bagian','Labeling','QC Visual','QC Ukuran','Packing','Finishing'],
  Jaket: ['Potong Pola','Jahit Lining','Pasang Zipper','Jahit Saku','Jahit Kerah','Bartack','Top Stitch','Setrika Bagian','QC Visual','QC Fungsi','QC Ukuran','Finishing'],
  Blouse: ['Potong Pola','Jahit Kerah','Jahit Manset','Jahit Bahu','Jahit Sisi','Jahit Hem','Obras Tepi','Top Stitch','Setrika Bagian','QC Visual','QC Ukuran','Finishing'],
  Kaos: ['Potong Kain','Rib Leher','Jahit Bahu','Jahit Sisi','Obras Keliling','Top Stitch','Setrika Bagian','Labeling','QC Visual','QC Ukuran','Packing','Finishing'],
  Hoodie: ['Potong Kain','Jahit Kapucong','Pasang Zipper','Jahit Lengan','Jahit Badan','Overlock Keliling','Top Stitch','Setrika Bagian','QC Visual','QC Fungsi','QC Ukuran','Finishing'],
  Gamis: ['Potong Pola','Jahit Kerut Panjang','Jahit Manset','Jahit Bahu','Jahit Sisi','Jahit Hem','Obras Tepi','Top Stitch','Setrika Bagian','QC Visual','QC Ukuran','Finishing']
};
function tasksForStyle(style) {
  const base = styleJobs[style] || jobNames;
  const out = [];
  while (out.length < 36) { out.push(base[out.length % base.length]); }
  return out;
}

let state = { lines: {}, list: [], meta: {} };
const DB_MYSQL = (process.env.DB_MYSQL || 'true').toLowerCase() === 'true';
let pool = null;
let poolButton = null;
let BUTTON_DB_READY = false;

async function discoverMasterUsersSchema({ host, user, password, port }) {
  try {
    const conn = await mysql.createConnection({ host, user, password, port });
    const [rows] = await conn.query("SELECT TABLE_SCHEMA AS s FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'master_users'");
    await conn.end();
    const schemas = Array.isArray(rows) ? rows.map(r => r.s || r.TABLE_SCHEMA || r.table_schema).filter(Boolean) : [];
    if (!schemas.length) return null;
    for (const s of schemas) {
      try {
        const test = await mysql.createConnection({ host, user, password, port, database: s });
        const [cnt] = await test.query('SELECT COUNT(*) AS c FROM master_users');
        await test.end();
        const c = (cnt && cnt[0] && (cnt[0].c || cnt[0].C)) || 0;
        if (c > 0) return s;
      } catch {}
    }
    return schemas[0] || null;
  } catch {
    return null;
  }
}

async function discoverMasterDataSchema({ host, user, password, port }) {
  try {
    const conn = await mysql.createConnection({ host, user, password, port });
    const [rows] = await conn.query("SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN ('master_lines','master_line','kategori_mesin','kategori','jenis_mesin','merk_mesin','merk')");
    await conn.end();
    const map = {};
    for (const r of rows) {
      const s = r.s || r.TABLE_SCHEMA || r.table_schema;
      const t = r.t || r.TABLE_NAME || r.table_name;
      if (!s || !t) continue;
      map[s] = (map[s] || 0) + 1;
    }
    let best = null; let max = 0;
    for (const [schema, cnt] of Object.entries(map)) { if (cnt > max) { max = cnt; best = schema; } }
    return best;
  } catch { return null; }
}

function toSqlDatetime(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function initMySQL() {
  if (pool) return;
  await initButtonDB();
  pool = poolButton;
}

function getMySQLPool() { return pool; }
function isButtonDbReady() { return BUTTON_DB_READY; }

 

async function initButtonDB() {
  if (poolButton) return;
  const host = process.env.DB_HOST || '127.0.0.1';
  const user = process.env.DB_USER || '';
  const password = process.env.DB_PASS || '';
  const port = Number(process.env.DB_PORT || 3306);
  let dbName = process.env.BUTTON_DB_NAME || 'button_db';
  try {
    const conn = await mysql.createConnection({ host, user, password, port });
    if (!process.env.BUTTON_DB_NAME) {
      const foundMaster = await discoverMasterDataSchema({ host, user, password, port });
      const foundUser = await discoverMasterUsersSchema({ host, user, password, port });
      const chosen = foundMaster || foundUser;
      if (chosen) dbName = chosen;
    }
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await conn.end();
    BUTTON_DB_READY = true;
  } catch {
    BUTTON_DB_READY = false;
  }
  poolButton = await mysql.createPool({
    host,
    user,
    password,
    port,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10
  });
  try {
    const [rows] = await poolButton.query('SELECT 1 AS ok');
    BUTTON_DB_READY = Array.isArray(rows);
  } catch {
    BUTTON_DB_READY = false;
  }
}

async function ensureButtonSchema() {
  await initButtonDB();
  if (!BUTTON_DB_READY) return;
  await poolButton.execute(
    'CREATE TABLE IF NOT EXISTS master_users (\n' +
    '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
    '  username VARCHAR(64),\n' +
    '  role VARCHAR(32),\n' +
    '  password VARCHAR(128),\n' +
    '  `lines` TEXT,\n' +
    '  UNIQUE KEY uniq_username (username)\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
  try {
    const dbName = process.env.BUTTON_DB_NAME || 'button_db';
    const [rows] = await poolButton.query('SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = "master_users" AND COLUMN_NAME = "password"', [dbName]);
    const c = (rows && rows[0] && (rows[0].c || rows[0].C)) || 0;
    if (!c) { await poolButton.execute('ALTER TABLE master_users ADD COLUMN password VARCHAR(128)'); }
  } catch { BUTTON_DB_READY = false; }
}

async function ensureButtonMasterSchema() {
  await initButtonDB();
  try {
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS kategori (\n' +
      '  id_kategori INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  name VARCHAR(128)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS jenis_mesin (\n' +
      '  id_jnsmesin INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  name VARCHAR(128)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS merk (\n' +
      '  id_merk INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  name VARCHAR(128),\n' +
      '  id_jnsmesin INT NULL,\n' +
      '  CONSTRAINT fk_jenis_mesin FOREIGN KEY (id_jnsmesin) REFERENCES jenis_mesin(id_jnsmesin)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS master_lines (\n' +
      '  id_line INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  nama_line VARCHAR(128)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS style_order (\n' +
      '  id_style INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  id_jenis_pakaian INT NULL,\n' +
      '  style_nama VARCHAR(128),\n' +
      '  id_line INT NULL\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
}

async function loadFromMySQL() {
  await ensurePrimarySchema();
  await ensureButtonMasterSchema();
  const [lineRows] = await pool.query('SELECT id, style, status FROM `lines`');
  const [machineRows] = await pool.query('SELECT id, line_id, job, status, good, reject, updated_at FROM `machines`');
  const masterRows = await getMasterLine();
  const names = Array.isArray(masterRows) ? masterRows.map(r => r.nama_line).filter(Boolean) : [];
  state.list = names;
  state.meta = {};
  for (const name of names) {
    const found = Array.isArray(lineRows) ? lineRows.find(r => r.id === name) : null;
    const style = found ? found.style : null;
    const status = found && found.status ? found.status : 'active';
    state.meta[name] = { style, status };
  }
  const map = {};
  for (const name of names) map[name] = [];
  for (const m of machineRows) {
    const dt = new Date(m.updated_at);
    const iso = isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
    if (!map[m.line_id]) map[m.line_id] = [];
    map[m.line_id].push({ line: m.line_id, machine: m.id, job: m.job, status: m.status, good: Number(m.good) || 0, reject: Number(m.reject) || 0, updatedAt: iso });
  }
  state.lines = map;
  save();
}

async function getStateLive() {
  if (!DB_MYSQL) {
    await refreshLinesFromMaster();
  } else {
    await loadFromMySQL();
  }
  return state;
}

async function getLinesLive() {
  try {
    await ensureButtonMasterSchema();
    const rows = await getMasterLine();
    const names = Array.isArray(rows) ? rows.map(r => r.nama_line).filter(Boolean) : [];
    if (names.length) {
      state.list = names;
      save();
      return names;
    }
  } catch {}
  return state.list || [];
}

async function getLineLive(line) {
  if (DB_MYSQL) {
    await initMySQL();
    const [rows] = await pool.execute('SELECT id, job, status, good, reject, updated_at FROM `machines` WHERE line_id = ?', [line]);
    return rows.map(m => {
      const dt = new Date(m.updated_at);
      const iso = isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
      return { line, machine: m.id, job: m.job, status: m.status, good: Number(m.good) || 0, reject: Number(m.reject) || 0, updatedAt: iso };
    });
  }
  return state.lines[line] || [];
}

async function getLineStyleLive(line) {
  if (DB_MYSQL) {
    await initMySQL();
    const [rows] = await pool.execute('SELECT style FROM `lines` WHERE id = ?', [line]);
    return rows.length ? rows[0].style : null;
  }
  return (state.meta && state.meta[line] && state.meta[line].style) || null;
}

async function getLineStatusLive(line) {
  if (DB_MYSQL) {
    await initMySQL();
    const [rows] = await pool.execute('SELECT status FROM `lines` WHERE id = ?', [line]);
    return rows.length ? (rows[0].status || 'active') : 'active';
  }
  return (state.meta && state.meta[line] && state.meta[line].status) || 'active';
}

async function getKategoriMaster() {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return [];
  try {
    const [rows] = await poolButton.query('SELECT id_kategori, name FROM kategori_mesin');
    return rows.map(r => ({ id_kategori: r.id_kategori, name: r.name }));
  } catch {
    const [rows2] = await poolButton.query('SELECT id_kategori, name FROM kategori');
    return rows2.map(r => ({ id_kategori: r.id_kategori, name: r.name }));
  }
}

async function createKategoriMaster({ name }) {
  await ensureButtonMasterSchema();
  let res;
  try {
    [res] = await poolButton.execute('INSERT INTO kategori_mesin (name) VALUES (?)', [name]);
  } catch {
    [res] = await poolButton.execute('INSERT INTO kategori (name) VALUES (?)', [name]);
  }
  return { id_kategori: res.insertId, name };
}

async function updateKategoriMaster(id, { name }) {
  await ensureButtonMasterSchema();
  try {
    await poolButton.execute('UPDATE kategori_mesin SET name = ? WHERE id_kategori = ?', [name, id]);
  } catch {
    await poolButton.execute('UPDATE kategori SET name = ? WHERE id_kategori = ?', [name, id]);
  }
  return { ok: true };
}

async function deleteKategoriMaster(id) {
  await ensureButtonMasterSchema();
  try {
    await poolButton.execute('DELETE FROM kategori_mesin WHERE id_kategori = ?', [id]);
  } catch {
    await poolButton.execute('DELETE FROM kategori WHERE id_kategori = ?', [id]);
  }
  return { ok: true };
}

async function getJenisMesinMaster() {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) {
    const fallback = ['Jahit','Obras','Bartack','Overlock','Press','QC'];
    return fallback.map((name, i) => ({ id_jnsmesin: i + 1, name }));
  }
  const [rows] = await poolButton.query('SELECT id_jnsmesin, name FROM jenis_mesin');
  return rows.map(r => ({ id_jnsmesin: r.id_jnsmesin, name: r.name }));
}

async function createJenisMesinMaster({ name }) {
  await ensureButtonMasterSchema();
  const [res] = await poolButton.execute('INSERT INTO jenis_mesin (name) VALUES (?)', [name]);
  return { id_jnsmesin: res.insertId, name };
}

async function updateJenisMesinMaster(id, { name }) {
  await ensureButtonMasterSchema();
  await poolButton.execute('UPDATE jenis_mesin SET name = ? WHERE id_jnsmesin = ?', [name, id]);
  return { ok: true };
}

async function deleteJenisMesinMaster(id) {
  await ensureButtonMasterSchema();
  await poolButton.execute('DELETE FROM jenis_mesin WHERE id_jnsmesin = ?', [id]);
  return { ok: true };
}

async function getMerkMaster() {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return [];
  try {
    const [rows] = await poolButton.query('SELECT m.id_merk, m.name, m.id_jnsmesin, j.name AS jenis_mesin FROM merk_mesin m LEFT JOIN jenis_mesin j ON m.id_jnsmesin = j.id_jnsmesin');
    return rows.map(r => ({ id_merk: r.id_merk, name: r.name, id_jnsmesin: r.id_jnsmesin, jenis_mesin: r.jenis_mesin }));
  } catch {
    const [rows2] = await poolButton.query('SELECT m.id_merk, m.name, m.id_jnsmesin, j.name AS jenis_mesin FROM merk m LEFT JOIN jenis_mesin j ON m.id_jnsmesin = j.id_jnsmesin');
    return rows2.map(r => ({ id_merk: r.id_merk, name: r.name, id_jnsmesin: r.id_jnsmesin, jenis_mesin: r.jenis_mesin }));
  }
}

async function createMerkMaster({ name, id_jnsmesin }) {
  await ensureButtonMasterSchema();
  let res;
  try {
    [res] = await poolButton.execute('INSERT INTO merk_mesin (name, id_jnsmesin) VALUES (?, ?)', [name, id_jnsmesin || null]);
  } catch {
    [res] = await poolButton.execute('INSERT INTO merk (name, id_jnsmesin) VALUES (?, ?)', [name, id_jnsmesin || null]);
  }
  return { id_merk: res.insertId, name, id_jnsmesin: id_jnsmesin || null };
}

async function updateMerkMaster(id, { name, id_jnsmesin }) {
  await ensureButtonMasterSchema();
  try {
    await poolButton.execute('UPDATE merk_mesin SET name = ?, id_jnsmesin = ? WHERE id_merk = ?', [name, id_jnsmesin || null, id]);
  } catch {
    await poolButton.execute('UPDATE merk SET name = ?, id_jnsmesin = ? WHERE id_merk = ?', [name, id_jnsmesin || null, id]);
  }
  return { ok: true };
}

async function deleteMerkMaster(id) {
  await ensureButtonMasterSchema();
  try {
    await poolButton.execute('DELETE FROM merk_mesin WHERE id_merk = ?', [id]);
  } catch {
    await poolButton.execute('DELETE FROM merk WHERE id_merk = ?', [id]);
  }
  return { ok: true };
}

async function getMasterLine() {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) {
    return (state.list || []).map((n, i) => ({ id_line: i + 1, nama_line: n }));
  }
  try {
    const [rows] = await poolButton.query('SELECT id_line, nama_line FROM master_lines');
    return rows.map(r => ({ id_line: r.id_line, nama_line: r.nama_line }));
  } catch {
    const [rows2] = await poolButton.query('SELECT id_line, nama_line FROM master_line');
    return rows2.map(r => ({ id_line: r.id_line, nama_line: r.nama_line }));
  }
}

async function createMasterLine({ nama_line }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { id_line: Date.now(), nama_line };
  let res;
  try {
    [res] = await poolButton.execute('INSERT INTO master_lines (nama_line) VALUES (?)', [nama_line]);
  } catch {
    [res] = await poolButton.execute('INSERT INTO master_line (nama_line) VALUES (?)', [nama_line]);
  }
  return { id_line: res.insertId, nama_line };
}

async function updateMasterLine(id, { nama_line }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  try {
    await poolButton.execute('UPDATE master_lines SET nama_line = ? WHERE id_line = ?', [nama_line, id]);
  } catch {
    await poolButton.execute('UPDATE master_line SET nama_line = ? WHERE id_line = ?', [nama_line, id]);
  }
  return { ok: true };
}

async function deleteMasterLine(id) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  try {
    await poolButton.execute('DELETE FROM master_lines WHERE id_line = ?', [id]);
  } catch {
    await poolButton.execute('DELETE FROM master_line WHERE id_line = ?', [id]);
  }
  return { ok: true };
}

function save() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));
  } catch {}
}

function load() {
  if (fs.existsSync(dbPath)) {
    try {
      const raw = fs.readFileSync(dbPath, 'utf-8');
      const data = JSON.parse(raw);
      state = data;
    } catch {}
  }
}

function seedInitial() {
  load();
  if (DB_MYSQL) { initMySQL().then(ensurePrimarySchema).then(loadFromMySQL).catch(() => {}); return; }
  initButtonDB().then(refreshLinesFromMaster).catch(() => {});
  // Jika daftar line sudah berasal dari database master_lines, jangan auto-generate mesin/style
  if (state.list && state.list.length) { save(); return; }
  state.lines = state.lines || {};
  if (state.list.length && state.list[0].startsWith('L') && !state.list[0].startsWith('Line')) {
    const newList = state.list.map(l => (l.startsWith('L') ? `Line ${parseInt(l.slice(1), 10)}` : l));
    const newLines = {};
    const newMeta = {};
    for (const oldKey of Object.keys(state.lines)) {
      const num = oldKey.startsWith('L') ? parseInt(oldKey.slice(1), 10) : null;
      const newKey = num ? `Line ${num}` : oldKey;
      const arr = state.lines[oldKey] || [];
      newLines[newKey] = arr.map(m => ({
        ...m,
        line: newKey,
        machine: m.machine.replace(oldKey, newKey)
      }));
      if (state.meta && state.meta[oldKey]) newMeta[newKey] = state.meta[oldKey];
    }
    state.list = newList;
    state.lines = newLines;
    state.meta = newMeta;
    save();
  }
  state.meta = state.meta || {};
  for (const lineId of state.list) {
    state.meta[lineId] = state.meta[lineId] || { style: null, status: 'active' };
  }
  save();
}

function getState() {
  return state;
}

function upsertMachine({ line, machine, job, good, reject, status }) {
  const arr = state.lines[line] || [];
  const idx = arr.findIndex(m => m.machine === machine);
  const now = new Date().toISOString();
  if (idx >= 0) {
    const cur = arr[idx];
    arr[idx] = {
      ...cur,
      job: job ?? cur.job,
      good: typeof good === 'number' ? good : cur.good,
      reject: typeof reject === 'number' ? reject : cur.reject,
      status: status ?? cur.status,
      updatedAt: now
    };
  } else {
    arr.push({ line, machine, job: job || 'Unknown', good: good || 0, reject: reject || 0, status: status || 'active', updatedAt: now });
  }
  state.lines[line] = arr;
  if (DB_MYSQL) {
    initMySQL().then(() => ensurePrimarySchema()).then(() => {
      const dt = toSqlDatetime(now);
      const vals = [machine, line, job || 'Unknown', status || 'active', typeof good === 'number' ? good : 0, typeof reject === 'number' ? reject : 0, dt];
      const sql = 'INSERT INTO `machines` (id, line_id, job, status, good, reject, updated_at) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE job=VALUES(job), status=VALUES(status), good=VALUES(good), reject=VALUES(reject), updated_at=VALUES(updated_at)';
      pool.execute(sql, vals).catch(() => {});
    }).catch(() => {});
  }
  save();
}

function incrementMachine({ line, machine, goodDelta = 0, rejectDelta = 0, status }) {
  const arr = state.lines[line] || [];
  const now = new Date().toISOString();
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    if (m.machine === machine) {
      if (m.status !== 'offline') {
        arr[i] = {
          ...m,
          good: m.good + (goodDelta || 0),
          reject: m.reject + (rejectDelta || 0),
          status: status ?? m.status,
          updatedAt: now
        };
      }
      break;
    }
  }
  state.lines[line] = arr;
  if (DB_MYSQL) {
    initMySQL().then(() => ensurePrimarySchema()).then(() => {
      const dt = toSqlDatetime(now);
      const sql = 'UPDATE `machines` SET good = good + ?, reject = reject + ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?';
      pool.execute(sql, [goodDelta || 0, rejectDelta || 0, status || null, dt, machine]).catch(() => {});
    }).catch(() => {});
  }
  save();
}

function getLines() {
  return state.list || [];
}

function getLine(line) {
  return state.lines[line] || [];
}

function getLineStyle(line) {
  return (state.meta && state.meta[line] && state.meta[line].style) || null;
}

function setLineStyle(line, style) {
  state.meta = state.meta || {};
  state.meta[line] = { style };
  const arr = state.lines[line] || [];
  const jobs = tasksForStyle(style);
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    arr[i] = { ...m, job: jobs[i % jobs.length], updatedAt: new Date().toISOString() };
  }
  state.lines[line] = arr;
  if (DB_MYSQL) {
    initMySQL().then(() => {
      pool.execute('UPDATE `lines` SET style = ? WHERE id = ?', [style, line]).catch(() => {});
      const updates = arr.map((m, idx) => pool.execute('UPDATE `machines` SET job = ? WHERE id = ?', [jobs[idx % jobs.length], m.machine]).catch(() => {}));
      Promise.all(updates).catch(() => {});
    }).catch(() => {});
  }
  save();
}

function setLineStatus(line, status) {
  state.meta = state.meta || {};
  const cur = state.meta[line] || {};
  state.meta[line] = { style: cur.style || null, status };
  if (DB_MYSQL) { initMySQL().then(() => { pool.execute('UPDATE `lines` SET status = ? WHERE id = ?', [status, line]).catch(() => {}); }).catch(() => {}); }
  save();
}

module.exports = { seedInitial, getState, getLines, getLine, getLineStyle, setLineStyle, setLineStatus, upsertMachine, incrementMachine, getStateLive, getLinesLive, getLineLive, getLineStyleLive, getLineStatusLive, 
  initMySQL, getMySQLPool,
  initButtonDB, ensureButtonSchema, getButtonPool: () => poolButton,
  ensurePrimarySchema,
  refreshLinesFromMaster,
  getKategoriMaster, createKategoriMaster, updateKategoriMaster, deleteKategoriMaster,
  getJenisMesinMaster, createJenisMesinMaster, updateJenisMesinMaster, deleteJenisMesinMaster,
  getMerkMaster, createMerkMaster, updateMerkMaster, deleteMerkMaster,
  getMasterLine, createMasterLine, updateMasterLine, deleteMasterLine,
  saveStyleOrder, getStyleOrderByLine, addProcessMachines,
  isButtonDbReady };
async function ensurePrimarySchema() {
  await initMySQL();
  await pool.execute(
    'CREATE TABLE IF NOT EXISTS `lines` (\n' +
    '  id VARCHAR(64) PRIMARY KEY,\n' +
    '  style VARCHAR(64),\n' +
    '  status VARCHAR(32)\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
  await pool.execute(
    'CREATE TABLE IF NOT EXISTS `machines` (\n' +
    '  id VARCHAR(64) PRIMARY KEY,\n' +
    '  line_id VARCHAR(64),\n' +
    '  job VARCHAR(64),\n' +
    '  status VARCHAR(32),\n' +
    '  good INT,\n' +
    '  reject INT,\n' +
    '  updated_at DATETIME,\n' +
    '  CONSTRAINT fk_line FOREIGN KEY (line_id) REFERENCES `lines`(id)\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
  await pool.execute(
    'CREATE TABLE IF NOT EXISTS `style_orders` (\n' +
    '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
    '  line_id VARCHAR(64),\n' +
    '  category VARCHAR(32),\n' +
    '  type VARCHAR(128),\n' +
    '  created_at DATETIME\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
  await pool.execute(
    'CREATE TABLE IF NOT EXISTS `style_processes` (\n' +
    '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
    '  order_id INT,\n' +
    '  name VARCHAR(128),\n' +
    '  position INT,\n' +
    '  CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES `style_orders`(id) ON DELETE CASCADE\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
}

async function refreshLinesFromMaster() {
  try {
    await ensureButtonMasterSchema();
    const rows = await getMasterLine();
    const names = Array.isArray(rows) ? rows.map(r => r.nama_line).filter(Boolean) : [];
    if (!names.length) return;
    state.list = names;
    state.lines = state.lines || {};
    state.meta = state.meta || {};
  for (const lineId of names) {
      const st = (state.meta[lineId] && state.meta[lineId].status) ? state.meta[lineId].status : 'active';
      state.meta[lineId] = { style: null, status: st };
      state.lines[lineId] = [];
    }
    save();
  } catch {}
}

async function saveStyleOrder({ line, category, type, processes }) {
  if (DB_MYSQL) {
    await ensurePrimarySchema();
    const now = toSqlDatetime(new Date().toISOString());
    const [rows] = await pool.execute('SELECT id FROM `style_orders` WHERE line_id = ? ORDER BY id DESC LIMIT 1', [line]);
    let orderId;
    if (rows && rows.length) {
      const oid = rows[0].id;
      await pool.execute('UPDATE `style_orders` SET category = ?, type = ?, created_at = ? WHERE id = ?', [category || '', type || '', now, oid]);
      await pool.execute('DELETE FROM `style_processes` WHERE order_id = ?', [oid]);
      orderId = oid;
    } else {
      const [ins] = await pool.execute('INSERT INTO `style_orders` (line_id, category, type, created_at) VALUES (?,?,?,?)', [line, category || '', type || '', now]);
      orderId = ins.insertId;
    }
    let pos = 0;
    for (const p of Array.isArray(processes) ? processes : []) {
      await pool.execute('INSERT INTO `style_processes` (order_id, name, position) VALUES (?,?,?)', [orderId, String(p.name || ''), pos++]);
    }
    await pool.execute('INSERT INTO `lines` (id, style, status) VALUES (?,?,?) ON DUPLICATE KEY UPDATE style=VALUES(style)', [line, type || null, 'active']);
  }
  try {
    await ensureButtonMasterSchema();
    let lineId = null;
    try {
      const [r1] = await poolButton.query('SELECT id_line FROM master_lines WHERE nama_line = ? LIMIT 1', [line]);
      if (Array.isArray(r1) && r1.length) lineId = r1[0].id_line;
    } catch {}
    if (lineId == null) {
      try {
        const [r2] = await poolButton.query('SELECT id_line FROM master_line WHERE nama_line = ? LIMIT 1', [line]);
        if (Array.isArray(r2) && r2.length) lineId = r2[0].id_line;
      } catch {}
    }
    try {
      console.log('style_order_write_attempt', { line, type, lineId });
      if (lineId != null) {
        const [ex] = await poolButton.query('SELECT id_style FROM style_order WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
        if (Array.isArray(ex) && ex.length) {
          await poolButton.execute('UPDATE style_order SET style_nama = ? WHERE id_style = ?', [type || '', ex[0].id_style]);
          console.log('style_order_update_ok', { id_style: ex[0].id_style });
        } else {
          await poolButton.execute('INSERT INTO style_order (style_nama, id_line) VALUES (?, ?)', [type || '', lineId]);
          console.log('style_order_insert_ok', { id_line: lineId });
        }
      } else {
        await poolButton.execute('INSERT INTO style_order (style_nama) VALUES (?)', [type || '']);
        console.log('style_order_insert_ok_no_line');
      }
    } catch (e) { console.error('style_order_write_error', { message: String(e && e.message || e) }); }
  } catch {}
  state.meta = state.meta || {};
  const cur = state.meta[line] || { status: 'active' };
  state.meta[line] = { style: type || null, status: cur.status || 'active' };
  save();
  return { ok: true };
}

async function getStyleOrderByLine(line) {
  if (DB_MYSQL) {
    await ensurePrimarySchema();
    const [rows] = await pool.execute('SELECT id, category, type FROM `style_orders` WHERE line_id = ? ORDER BY id DESC LIMIT 1', [line]);
    const order = rows && rows[0] ? rows[0] : null;
    if (!order) {
      try {
        await ensureButtonMasterSchema();
        let lineId = null;
        try {
          const [r1] = await poolButton.query('SELECT id_line FROM master_lines WHERE nama_line = ? LIMIT 1', [line]);
          if (Array.isArray(r1) && r1.length) lineId = r1[0].id_line;
        } catch {}
        if (lineId == null) {
          try {
            const [r2] = await poolButton.query('SELECT id_line FROM master_line WHERE nama_line = ? LIMIT 1', [line]);
            if (Array.isArray(r2) && r2.length) lineId = r2[0].id_line;
          } catch {}
        }
        if (lineId != null) {
          const [so] = await poolButton.query('SELECT style_nama FROM style_order WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
          if (Array.isArray(so) && so.length) {
            return { order: { category: '', type: so[0].style_nama }, processes: [] };
          }
        }
      } catch {}
      return { order: null, processes: [] };
    }
    const [procs] = await pool.execute('SELECT name, position FROM `style_processes` WHERE order_id = ? ORDER BY position ASC, id ASC', [order.id]);
    return { order: { category: order.category, type: order.type }, processes: procs.map(r => ({ name: r.name })) };
  }
  const curStyle = getLineStyle(line);
  return { order: curStyle ? { category: '', type: curStyle } : null, processes: [] };
}

async function addProcessMachines({ line, processName, machineType, qty }) {
  const count = Math.max(1, Number(qty) || 1);
  const existing = await getLineLive(line);
  let idx = 1;
  function nextId() {
    let candidate = `${line}-${processName}-${machineType}-${idx}`;
    idx++;
    return candidate;
  }
  for (let i = 0; i < count; i++) {
    let id = nextId();
    while (existing.find(m => m.machine === id)) { id = nextId(); }
    upsertMachine({ line, machine: id, job: processName || 'Unknown', good: 0, reject: 0, status: 'active' });
  }
  return { ok: true };
}
