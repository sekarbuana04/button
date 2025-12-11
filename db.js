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

 

async function initButtonDB() {
  if (poolButton) return;
  const host = process.env.DB_HOST || '127.0.0.1';
  const user = process.env.DB_USER || '';
  const password = process.env.DB_PASS || '';
  const port = Number(process.env.DB_PORT || 3306);
  let dbName = process.env.BUTTON_DB_NAME || 'button_db';
  try {
    const conn = await mysql.createConnection({ host, user, password, port });
    const found = await discoverMasterUsersSchema({ host, user, password, port });
    if (found) dbName = found;
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await conn.end();
  } catch {}
  poolButton = await mysql.createPool({
    host,
    user,
    password,
    port,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10
  });
}

async function ensureButtonSchema() {
  await initButtonDB();
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
  } catch {}
}

async function ensureButtonMasterSchema() {
  await initButtonDB();
  await poolButton.execute(
    'CREATE TABLE IF NOT EXISTS kategori (\n' +
    '  id_kategori INT AUTO_INCREMENT PRIMARY KEY,\n' +
    '  name VARCHAR(128)\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
  await poolButton.execute(
    'CREATE TABLE IF NOT EXISTS jenis_mesin (\n' +
    '  id_jnsmesin INT AUTO_INCREMENT PRIMARY KEY,\n' +
    '  name VARCHAR(128)\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
  await poolButton.execute(
    'CREATE TABLE IF NOT EXISTS merk (\n' +
    '  id_merk INT AUTO_INCREMENT PRIMARY KEY,\n' +
    '  name VARCHAR(128),\n' +
    '  id_jnsmesin INT NULL,\n' +
    '  CONSTRAINT fk_jenis_mesin FOREIGN KEY (id_jnsmesin) REFERENCES jenis_mesin(id_jnsmesin)\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
  await poolButton.execute(
    'CREATE TABLE IF NOT EXISTS master_line (\n' +
    '  id_line INT AUTO_INCREMENT PRIMARY KEY,\n' +
    '  nama_line VARCHAR(128)\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
}

async function loadFromMySQL() {
  await ensurePrimarySchema();
  const [lineRows] = await pool.query('SELECT id, style, status FROM `lines`');
  const [machineRows] = await pool.query('SELECT id, line_id, job, status, good, reject, updated_at FROM `machines`');
  state.list = lineRows.map(r => r.id);
  state.meta = {};
  for (const r of lineRows) state.meta[r.id] = { style: r.style, status: r.status || 'active' };
  const map = {};
  for (const id of state.list) map[id] = [];
  for (const m of machineRows) {
    const dt = new Date(m.updated_at);
    const iso = isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
    map[m.line_id].push({ line: m.line_id, machine: m.id, job: m.job, status: m.status, good: Number(m.good) || 0, reject: Number(m.reject) || 0, updatedAt: iso });
  }
  state.lines = map;
  save();
}

async function getStateLive() {
  if (DB_MYSQL) {
    await loadFromMySQL();
  }
  return state;
}

async function getLinesLive() {
  if (DB_MYSQL) {
    await initMySQL();
    const [rows] = await pool.query('SELECT id FROM `lines`');
    return rows.map(r => r.id);
  }
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
  const [rows] = await poolButton.query('SELECT id_kategori, name FROM kategori');
  return rows.map(r => ({ id_kategori: r.id_kategori, name: r.name }));
}

async function createKategoriMaster({ name }) {
  await ensureButtonMasterSchema();
  const [res] = await poolButton.execute('INSERT INTO kategori (name) VALUES (?)', [name]);
  return { id_kategori: res.insertId, name };
}

async function updateKategoriMaster(id, { name }) {
  await ensureButtonMasterSchema();
  await poolButton.execute('UPDATE kategori SET name = ? WHERE id_kategori = ?', [name, id]);
  return { ok: true };
}

async function deleteKategoriMaster(id) {
  await ensureButtonMasterSchema();
  await poolButton.execute('DELETE FROM kategori WHERE id_kategori = ?', [id]);
  return { ok: true };
}

async function getJenisMesinMaster() {
  await ensureButtonMasterSchema();
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
  const [rows] = await poolButton.query('SELECT m.id_merk, m.name, m.id_jnsmesin, j.name AS jenis_mesin FROM merk m LEFT JOIN jenis_mesin j ON m.id_jnsmesin = j.id_jnsmesin');
  return rows.map(r => ({ id_merk: r.id_merk, name: r.name, id_jnsmesin: r.id_jnsmesin, jenis_mesin: r.jenis_mesin }));
}

async function createMerkMaster({ name, id_jnsmesin }) {
  await ensureButtonMasterSchema();
  const [res] = await poolButton.execute('INSERT INTO merk (name, id_jnsmesin) VALUES (?, ?)', [name, id_jnsmesin || null]);
  return { id_merk: res.insertId, name, id_jnsmesin: id_jnsmesin || null };
}

async function updateMerkMaster(id, { name, id_jnsmesin }) {
  await ensureButtonMasterSchema();
  await poolButton.execute('UPDATE merk SET name = ?, id_jnsmesin = ? WHERE id_merk = ?', [name, id_jnsmesin || null, id]);
  return { ok: true };
}

async function deleteMerkMaster(id) {
  await ensureButtonMasterSchema();
  await poolButton.execute('DELETE FROM merk WHERE id_merk = ?', [id]);
  return { ok: true };
}

async function getMasterLine() {
  await ensureButtonMasterSchema();
  const [rows] = await poolButton.query('SELECT id_line, nama_line FROM master_line');
  return rows.map(r => ({ id_line: r.id_line, nama_line: r.nama_line }));
}

async function createMasterLine({ nama_line }) {
  await ensureButtonMasterSchema();
  const [res] = await poolButton.execute('INSERT INTO master_line (nama_line) VALUES (?)', [nama_line]);
  return { id_line: res.insertId, nama_line };
}

async function updateMasterLine(id, { nama_line }) {
  await ensureButtonMasterSchema();
  await poolButton.execute('UPDATE master_line SET nama_line = ? WHERE id_line = ?', [nama_line, id]);
  return { ok: true };
}

async function deleteMasterLine(id) {
  await ensureButtonMasterSchema();
  await poolButton.execute('DELETE FROM master_line WHERE id_line = ?', [id]);
  return { ok: true };
}

function save() {
  fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));
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
  if (!state.list || state.list.length === 0) {
    state.list = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
  }
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
    const styles = styleList;
    const s = (state.meta[lineId] && state.meta[lineId].style) ? state.meta[lineId].style : styles[Math.floor(Math.random() * styles.length)];
    const st = (state.meta[lineId] && state.meta[lineId].status) ? state.meta[lineId].status : (Math.random() < 0.85 ? 'active' : 'offline');
    state.meta[lineId] = { style: s, status: st };
    if (!state.lines[lineId] || state.lines[lineId].length === 0) {
      const arr = [];
      const jobs = tasksForStyle(s);
      for (let i = 1; i <= 36; i++) {
        const inactive = Math.random() < 0.25;
        arr.push({
          line: lineId,
          machine: `${lineId}-${i}`,
          job: jobs[i - 1],
          good: 0,
          reject: 0,
          status: inactive ? 'offline' : 'active',
          updatedAt: new Date().toISOString()
        });
      }
      state.lines[lineId] = arr;
    }
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
  getKategoriMaster, createKategoriMaster, updateKategoriMaster, deleteKategoriMaster,
  getJenisMesinMaster, createJenisMesinMaster, updateJenisMesinMaster, deleteJenisMesinMaster,
  getMerkMaster, createMerkMaster, updateMerkMaster, deleteMerkMaster,
  getMasterLine, createMasterLine, updateMasterLine, deleteMasterLine };
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
}
