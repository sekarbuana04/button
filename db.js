const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'production.json');



let state = { lines: {}, list: [], meta: {} };
const DB_MYSQL = String(process.env.DB_MYSQL || '').toLowerCase() === 'true';
const TRY_BUTTON_DB = Boolean(process.env.DB_HOST || process.env.DB_USER || process.env.DB_PASSWORD || process.env.DB_PASS || process.env.DB_PORT || process.env.BUTTON_DB_NAME);
let pool = null;
let poolButton = null;
let BUTTON_DB_READY = false;
let poolIot = null;
let IOT_DB_READY = false;
let IOT_PROC_READY = false;

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
    const [rows] = await conn.query("SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN ('daftar_line','master_lines','master_line','kategori_mesin','kategori','jenis_mesin','merk_mesin','merk')");
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
  const port = Number(process.env.DB_PORT || 3306);
  const user = (process.env.DB_USER && String(process.env.DB_USER).trim()) ? String(process.env.DB_USER).trim() : '';
  const password = process.env.DB_PASSWORD || process.env.DB_PASS || '';
  let dbName = process.env.BUTTON_DB_NAME || 'button_db';
  if (!user) { BUTTON_DB_READY = false; return; }
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
  } catch {
    BUTTON_DB_READY = false;
    return;
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
  try {
    await dropTableWithFk(poolButton, 'machine_tx');
  } catch {}
  try {
    await dropTableWithFk(poolButton, 'transmitters');
  } catch {}
}

async function initIotDB() {
  if (poolIot) return;
  await initButtonDB();
  poolIot = poolButton;
  IOT_DB_READY = Boolean(BUTTON_DB_READY && poolIot);
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
  const poolConn = poolButton;
  try {
    const hasDaftar = await tableExists(poolConn, 'daftar_line');
    const hasMasterLines = await tableExists(poolConn, 'master_lines');
    if (!hasDaftar && hasMasterLines) {
      try { await poolConn.execute('RENAME TABLE `master_lines` TO `daftar_line`'); } catch {}
    }
    if (hasDaftar && hasMasterLines) {
      let merged = false;
      try {
        await poolConn.execute(
          'INSERT INTO daftar_line (id_line, nama_line) ' +
          'SELECT ml.id_line, ml.nama_line FROM master_lines ml ' +
          'LEFT JOIN daftar_line dl ON dl.id_line = ml.id_line ' +
          'WHERE dl.id_line IS NULL'
        );
        merged = true;
      } catch {}
      if (merged) {
        try { await dropTableWithFk(poolConn, 'master_lines'); } catch {}
      }
    }
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS jenis_mesin (\n' +
      '  id_jnsmesin INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  name VARCHAR(128)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS merk_mesin (\n' +
      '  id_merk INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  name VARCHAR(128),\n' +
      '  id_jnsmesin INT NULL,\n' +
      '  CONSTRAINT fk_mm_jenis FOREIGN KEY (id_jnsmesin) REFERENCES jenis_mesin(id_jnsmesin)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS daftar_line (\n' +
      '  id_line INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  nama_line VARCHAR(128)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS master_orders (\n' +
      '  id_line INT PRIMARY KEY,\n' +
      '  category VARCHAR(32),\n' +
      '  type VARCHAR(128),\n' +
      '  total_processes INT NOT NULL DEFAULT 0,\n' +
      '  total_machines INT NOT NULL DEFAULT 0,\n' +
      '  updated_at DATETIME NULL,\n' +
      '  CONSTRAINT fk_mo_line FOREIGN KEY (id_line) REFERENCES daftar_line(id_line)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS master_order_list (\n' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  orc VARCHAR(128) NOT NULL,\n' +
      '  po VARCHAR(128) NOT NULL,\n' +
      '  buyer VARCHAR(128) NULL,\n' +
      '  style VARCHAR(128) NOT NULL,\n' +
      '  color VARCHAR(64) NULL,\n' +
      '  qty INT NOT NULL DEFAULT 0,\n' +
      '  shipment_date DATE NULL,\n' +
      '  description VARCHAR(255) NULL,\n' +
      '  created_at DATETIME NULL,\n' +
      '  updated_at DATETIME NULL,\n' +
      '  UNIQUE KEY uniq_orc (orc),\n' +
      '  KEY idx_po (po),\n' +
      '  KEY idx_style (style)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS machine_tx (\n' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  line VARCHAR(128) NOT NULL,\n' +
      '  machine VARCHAR(256) NOT NULL,\n' +
      '  tx VARCHAR(64) NOT NULL,\n' +
      '  created_at DATETIME NULL,\n' +
      '  UNIQUE KEY uniq_tx (tx),\n' +
      '  UNIQUE KEY uniq_line_machine (line, machine)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS style_order (\n' +
      '  id_style INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  id_jenis_pakaian INT NULL,\n' +
      '  style_nama VARCHAR(128),\n' +
      '  id_line INT NULL\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS master_styles (\n' +
      '  id_style INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  id_line INT NULL,\n' +
      '  category VARCHAR(32),\n' +
      '  style_nama VARCHAR(128),\n' +
      '  created_at DATETIME NULL\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS style_proses (\n' +
      '  id_proses INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  id_style INT,\n' +
      '  nama_proses VARCHAR(128)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS master_mesin (\n' +
      '  id_mesin INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  id_merk INT NULL,\n' +
      '  id_jnsmesin INT NULL,\n' +
      '  id_kategori INT NULL\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try { await poolConn.execute('ALTER TABLE style_order MODIFY id_jenis_pakaian INT NULL DEFAULT NULL'); } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS proses_produksi (\n' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  nama VARCHAR(128) UNIQUE\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS jenis_pakaian (\n' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  nama VARCHAR(128) NOT NULL,\n' +
      '  UNIQUE KEY uniq_jenis_pakaian_nama (nama)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolConn.execute(
      'CREATE TABLE IF NOT EXISTS alur_jahit (\n' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  jenis_id INT NOT NULL,\n' +
      '  proses_id INT NOT NULL,\n' +
      '  position INT NOT NULL DEFAULT 0,\n' +
      '  KEY idx_alur_jenis (jenis_id),\n' +
      '  KEY idx_alur_proses (proses_id)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    const existsKategori = await tableExists(poolConn, 'kategori');
    if (existsKategori) await dropTableWithFk(poolConn, 'kategori');
    const existsSpm = await tableExists(poolConn, 'style_proses_mesin');
    if (existsSpm) await dropTableWithFk(poolConn, 'style_proses_mesin');
    try { await dropTableWithFk(poolConn, 'machine_tx'); } catch {}
    try { await dropTableWithFk(poolConn, 'transmitters'); } catch {}
  } catch {}
}

async function loadFromMySQL() {
  await ensureButtonMasterSchema();
  const masterRows = await getMasterLine();
  const names = Array.isArray(masterRows) ? masterRows.map(r => r.nama_line).filter(Boolean) : [];
  state.list = names;
  const prevMeta = state.meta || {};
  const nextMeta = {};
  for (const name of names) {
    let styleName = null;
    try {
      const lineId = await resolveLineIdByName(name);
      if (lineId != null) {
        const [so] = await poolButton.query('SELECT style_nama FROM style_order WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
        styleName = Array.isArray(so) && so[0] ? (so[0].style_nama || null) : null;
      }
    } catch {}
    const status = (prevMeta && prevMeta[name] && prevMeta[name].status) || 'active';
    const processes = (prevMeta && prevMeta[name] && prevMeta[name].processes) || [];
    const defaults = (prevMeta && prevMeta[name] && prevMeta[name].defaults) || {};
    nextMeta[name] = { style: styleName, status, processes, defaults };
  }
  state.meta = nextMeta;
  const prevLines = state.lines || {};
  const newLines = { ...prevLines };
  for (const name of names) { if (!newLines[name]) newLines[name] = []; }
  state.lines = newLines;
  save();
}

async function getStateLive() {
  if (DB_MYSQL) {
    try {
      await loadFromMySQL();
      return state;
    } catch {}
  }
  try { await refreshLinesFromMaster(); } catch {}
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
  try {
    await ensureButtonMasterSchema();
    const arr = state.lines[line] || [];
    const [rows] = await poolButton.query('SELECT machine, tx FROM machine_tx WHERE line = ?', [line]);
    const map = {};
    for (const r of Array.isArray(rows) ? rows : []) { map[String(r.machine)] = String(r.tx); }
    return arr.map(m => ({ ...m, tx: map[m.machine] || null }));
  } catch {
    return state.lines[line] || [];
  }
}

async function getLineStyleLive(line) {
  try {
    await ensureButtonMasterSchema();
    const lineId = await resolveLineIdByName(line);
    if (lineId != null) {
      const [so] = await poolButton.query('SELECT style_nama FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
      return (Array.isArray(so) && so[0]) ? (so[0].style_nama || null) : null;
    }
  } catch {}
  return (state.meta && state.meta[line] && state.meta[line].style) || null;
}

async function getLineStatusLive(line) {
  return (state.meta && state.meta[line] && state.meta[line].status) || 'active';
}


async function getJenisMesinMaster() {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) { return []; }
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
  try {
    const [rows] = await poolButton.query('SELECT m.id_merk, m.name, m.id_jnsmesin, j.name AS jenis_mesin FROM merk_mesin m LEFT JOIN jenis_mesin j ON m.id_jnsmesin = j.id_jnsmesin');
    return rows.map(r => ({ id_merk: r.id_merk, name: r.name, id_jnsmesin: r.id_jnsmesin, jenis_mesin: r.jenis_mesin }));
  } catch {}
  try {
    const [rows2] = await poolButton.query('SELECT m.id_merk, m.name, m.id_jnsmesin, j.name AS jenis_mesin FROM merk m LEFT JOIN jenis_mesin j ON m.id_jnsmesin = j.id_jnsmesin');
    return rows2.map(r => ({ id_merk: r.id_merk, name: r.name, id_jnsmesin: r.id_jnsmesin, jenis_mesin: r.jenis_mesin }));
  } catch {}
  return [];
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

async function getProsesProduksi() {
  await ensureButtonMasterSchema();
  try {
    const [rows] = await poolButton.query('SELECT id, nama FROM proses_produksi ORDER BY nama ASC');
    return rows.map(r => ({ id: r.id, nama: r.nama }));
  } catch {
    return [];
  }
}

async function createProsesProduksi({ nama }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { id: Date.now(), nama };
  const n = String(nama || '').trim();
  if (!n) return { id: null, nama: '' };
  try {
    const [ins] = await poolButton.execute('INSERT INTO proses_produksi (nama) VALUES (?)', [n]);
    return { id: ins && ins.insertId != null ? ins.insertId : null, nama: n };
  } catch {
    try {
      const [rows] = await poolButton.query('SELECT id, nama FROM proses_produksi WHERE nama = ? LIMIT 1', [n]);
      if (Array.isArray(rows) && rows.length) return { id: rows[0].id, nama: rows[0].nama };
    } catch {}
    return { id: null, nama: n };
  }
}

async function updateProsesProduksi(id, { nama }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  const n = String(nama || '').trim();
  try {
    await poolButton.execute('UPDATE proses_produksi SET nama = ? WHERE id = ?', [n || null, id]);
  } catch {}
  return { ok: true };
}

async function deleteProsesProduksi(id) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  try {
    await poolButton.execute('DELETE FROM proses_produksi WHERE id = ?', [id]);
  } catch {}
  return { ok: true };
}

async function getJenisPakaian() {
  await ensureButtonMasterSchema();
  try {
    const [rows] = await poolButton.query('SELECT id, nama FROM jenis_pakaian ORDER BY id ASC');
    return (Array.isArray(rows) ? rows : []).map(r => ({ id: r.id, nama: r.nama }));
  } catch {
    return [];
  }
}

async function createJenisPakaian({ nama }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { id: Date.now(), nama };
  const n = String(nama || '').trim();
  if (!n) return { id: null, nama: '' };
  try {
    const [ins] = await poolButton.execute('INSERT INTO jenis_pakaian (nama) VALUES (?)', [n]);
    return { id: ins && ins.insertId != null ? ins.insertId : null, nama: n };
  } catch {
    try {
      const [rows] = await poolButton.query('SELECT id, nama FROM jenis_pakaian WHERE nama = ? LIMIT 1', [n]);
      if (Array.isArray(rows) && rows.length) return { id: rows[0].id, nama: rows[0].nama };
    } catch {}
    return { id: null, nama: n };
  }
}

async function updateJenisPakaian(id, { nama }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  const n = String(nama || '').trim();
  if (!n) return { ok: false };
  try {
    await poolButton.execute('UPDATE jenis_pakaian SET nama = ? WHERE id = ?', [n, id]);
  } catch {}
  return { ok: true };
}

async function deleteJenisPakaian(id) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  try { await poolButton.execute('DELETE FROM alur_jahit WHERE jenis_id = ?', [id]); } catch {}
  try { await poolButton.execute('UPDATE style_order SET id_jenis_pakaian = NULL WHERE id_jenis_pakaian = ?', [id]); } catch {}
  try { await poolButton.execute('DELETE FROM jenis_pakaian WHERE id = ?', [id]); } catch {}
  return { ok: true };
}

async function getAlurJahitByJenisId(jenisId) {
  await ensureButtonMasterSchema();
  try {
    const [rows] = await poolButton.query(
      'SELECT aj.proses_id, pp.nama AS proses_nama, aj.position ' +
      'FROM alur_jahit aj LEFT JOIN proses_produksi pp ON pp.id = aj.proses_id ' +
      'WHERE aj.jenis_id = ? ORDER BY aj.position ASC, aj.id ASC',
      [jenisId]
    );
    return (Array.isArray(rows) ? rows : []).map(r => ({ proses_id: r.proses_id, proses_nama: r.proses_nama || '' }));
  } catch {
    return [];
  }
}

async function setAlurJahitByJenisId(jenisId, prosesIds) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  const jenis = Number(jenisId);
  if (!Number.isFinite(jenis)) return { ok: false };
  const ids = (Array.isArray(prosesIds) ? prosesIds : [])
    .map(x => Number(x))
    .filter(x => Number.isFinite(x));
  try { await poolButton.execute('DELETE FROM alur_jahit WHERE jenis_id = ?', [jenis]); } catch {}
  let pos = 0;
  for (const pid of ids) {
    try { await poolButton.execute('INSERT INTO alur_jahit (jenis_id, proses_id, position) VALUES (?,?,?)', [jenis, pid, pos++]); } catch {}
  }
  return { ok: true };
}

async function getMasterLine() {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) { return []; }
  try {
    const [rows] = await poolButton.query('SELECT id_line, nama_line FROM daftar_line');
    return rows.map(r => ({ id_line: r.id_line, nama_line: r.nama_line }));
  } catch {}
  return [];
}

async function resolveLineIdByName(name) {
  await ensureButtonMasterSchema();
  const q = String(name || '').trim();
  if (!q) return null;
  try {
    const [r1] = await poolButton.query('SELECT id_line FROM daftar_line WHERE nama_line = ? LIMIT 1', [q]);
    if (Array.isArray(r1) && r1.length) return r1[0].id_line;
  } catch {}
  try {
    const [r3] = await poolButton.query('SELECT id_line FROM daftar_line WHERE UPPER(nama_line) = UPPER(?) LIMIT 1', [q]);
    if (Array.isArray(r3) && r3.length) return r3[0].id_line;
  } catch {}
  try {
    const [r4] = await poolButton.query('SELECT id_line FROM daftar_line WHERE REPLACE(UPPER(nama_line), " ", "") = REPLACE(UPPER(?), " ", "") LIMIT 1', [q]);
    if (Array.isArray(r4) && r4.length) return r4[0].id_line;
  } catch {}
  return null;
}

async function createMasterLine({ nama_line }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { id_line: Date.now(), nama_line };
  let res;
  try {
    [res] = await poolButton.execute('INSERT INTO daftar_line (nama_line) VALUES (?)', [nama_line]);
  } catch {}
  return { id_line: res.insertId, nama_line };
}

async function updateMasterLine(id, { nama_line }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  try {
    await poolButton.execute('UPDATE daftar_line SET nama_line = ? WHERE id_line = ?', [nama_line, id]);
  } catch {}
  return { ok: true };
}

async function deleteMasterLine(id) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  try {
    await poolButton.execute('DELETE FROM daftar_line WHERE id_line = ?', [id]);
  } catch {}
  return { ok: true };
}

async function getMasterStyles() {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) { return []; }
  try {
    const [rows] = await poolButton.query(
      'SELECT ms.id_style, ms.style_nama, ms.category, ms.id_line, ml.nama_line, ms.created_at ' +
      'FROM master_styles ms LEFT JOIN daftar_line ml ON ml.id_line = ms.id_line ' +
      'ORDER BY ms.id_style DESC'
    );
    return (Array.isArray(rows) ? rows : []).map(r => ({
      id_style: r.id_style,
      style_nama: r.style_nama,
      category: r.category || '',
      id_line: r.id_line,
      line: r.nama_line || null,
      created_at: r.created_at
    }));
  } catch {}
  return [];
}

async function updateMasterStyle(id, { style_nama }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  const nm = String(style_nama || '').trim();
  try {
    await poolButton.execute('UPDATE master_styles SET style_nama = ? WHERE id_style = ?', [nm || null, id]);
  } catch {}
  return { ok: true };
}

async function deleteMasterStyle(id) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  const styleId = id;
  try {
    const [procRows] = await poolButton.query('SELECT id_proses FROM style_proses WHERE id_style = ?', [styleId]);
    for (const pr of Array.isArray(procRows) ? procRows : []) {
      const procId = pr && pr.id_proses != null ? pr.id_proses : null;
      if (procId == null) continue;
      try { await poolButton.execute('DELETE FROM proses_mesin WHERE id_proses = ?', [procId]); } catch {}
    }
  } catch {}
  try { await poolButton.execute('DELETE FROM style_proses WHERE id_style = ?', [styleId]); } catch {}
  try { await poolButton.execute('DELETE FROM master_styles WHERE id_style = ?', [styleId]); } catch {}
  return { ok: true };
}

function sanitizeOrcPart(v) {
  return String(v || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 32);
}

function parseOrcSuffix(orc) {
  const s = String(orc || '').trim();
  const m = s.match(/-([A-Z])(\d{3})$/);
  if (!m) return null;
  return { letter: m[1], num: Number(m[2]) };
}

async function generateOrc({ po, buyer }) {
  await ensureButtonMasterSchema();
  const poPart = sanitizeOrcPart(po);
  const buyerPart = sanitizeOrcPart(buyer) || 'NA';
  const prefix = `${poPart}-${buyerPart}`;
  if (!poPart) return null;
  try {
    const [rows] = await poolButton.query('SELECT orc FROM master_order_list WHERE orc LIKE ? ORDER BY id DESC LIMIT 2000', [`${prefix}-%`]);
    const used = new Set(
      (Array.isArray(rows) ? rows : [])
        .map(r => parseOrcSuffix(r && r.orc))
        .filter(Boolean)
        .map(x => `${x.letter}${String(x.num).padStart(3, '0')}`)
    );
    for (let li = 0; li < 26; li++) {
      const letter = String.fromCharCode(65 + li);
      for (let n = 1; n <= 999; n++) {
        const suf = `${letter}${String(n).padStart(3, '0')}`;
        if (!used.has(suf)) return `${prefix}-${suf}`;
      }
    }
  } catch {}
  return `${prefix}-A001`;
}

async function listMasterOrderList({ q } = {}) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return [];
  const query = String(q || '').trim();
  try {
    if (query) {
      const like = `%${query}%`;
      const [rows] = await poolButton.query(
        'SELECT id, orc, po, style, color, qty, shipment_date, description ' +
        'FROM master_order_list ' +
        'WHERE orc LIKE ? OR po LIKE ? OR style LIKE ? OR color LIKE ? ' +
        'ORDER BY id DESC LIMIT 500',
        [like, like, like, like]
      );
      return Array.isArray(rows) ? rows : [];
    }
    const [rows] = await poolButton.query(
      'SELECT id, orc, po, style, color, qty, shipment_date, description ' +
      'FROM master_order_list ORDER BY id DESC LIMIT 500'
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function createMasterOrderList({ po, buyer, style, color, qty, shipment_date, description }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: false };
  const poVal = String(po || '').trim();
  const buyerVal = String(buyer || '').trim();
  const styleVal = String(style || '').trim();
  const colorVal = String(color || '').trim();
  const qtyVal = Number(qty || 0);
  const shipVal = shipment_date ? String(shipment_date).slice(0, 10) : null;
  const descVal = String(description || '').trim();
  if (!poVal || !styleVal) return { ok: false };
  const orc = await generateOrc({ po: poVal, buyer: buyerVal });
  if (!orc) return { ok: false };
  const now = toSqlDatetime(new Date().toISOString());
  try {
    const [ins] = await poolButton.execute(
      'INSERT INTO master_order_list (orc, po, buyer, style, color, qty, shipment_date, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [orc, poVal, buyerVal || null, styleVal, colorVal || null, Number.isFinite(qtyVal) ? qtyVal : 0, shipVal || null, descVal || null, now, now]
    );
    return { ok: true, data: { id: ins && ins.insertId, orc, po: poVal, style: styleVal, color: colorVal || null, qty: Number.isFinite(qtyVal) ? qtyVal : 0, shipment_date: shipVal || null, description: descVal || null } };
  } catch {
    return { ok: false };
  }
}

async function updateMasterOrderListByOrc(orc, { po, buyer, style, color, qty, shipment_date, description }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: false };
  const orcVal = String(orc || '').trim();
  if (!orcVal) return { ok: false };

  const poVal = String(po || '').trim();
  const buyerVal = String(buyer || '').trim();
  const styleVal = String(style || '').trim();
  const colorVal = String(color || '').trim();
  const qtyVal = Number(qty || 0);
  const shipVal = shipment_date ? String(shipment_date).slice(0, 10) : null;
  const descVal = String(description || '').trim();
  if (!poVal || !styleVal) return { ok: false };

  const now = toSqlDatetime(new Date().toISOString());
  try {
    await poolButton.execute(
      'UPDATE master_order_list SET po = ?, buyer = ?, style = ?, color = ?, qty = ?, shipment_date = ?, description = ?, updated_at = ? WHERE orc = ? LIMIT 1',
      [poVal, buyerVal || null, styleVal, colorVal || null, Number.isFinite(qtyVal) ? qtyVal : 0, shipVal || null, descVal || null, now, orcVal]
    );
    const [rows] = await poolButton.query(
      'SELECT id, orc, po, style, color, qty, shipment_date, description FROM master_order_list WHERE orc = ? LIMIT 1',
      [orcVal]
    );
    return { ok: true, data: (Array.isArray(rows) && rows[0]) ? rows[0] : null };
  } catch {
    return { ok: false };
  }
}

async function deleteMasterOrderListByOrc(orc) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: false };
  const v = String(orc || '').trim();
  if (!v) return { ok: false };
  try {
    await poolButton.execute('DELETE FROM master_order_list WHERE orc = ? LIMIT 1', [v]);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function save() {
  try {
    const tmpPath = `${dbPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, dbPath);
  } catch {}
}

function load() {
  try {
    if (!fs.existsSync(dbPath)) return;
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    state = {
      lines: parsed.lines && typeof parsed.lines === 'object' ? parsed.lines : {},
      list: Array.isArray(parsed.list) ? parsed.list : [],
      meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
      iot: parsed.iot && typeof parsed.iot === 'object' ? parsed.iot : { receivers: [], summary: {}, logs: [], resets: [] }
    };
  } catch {}
}

function seedInitial() {
  load();
  if (DB_MYSQL) {
    initMySQL()
      .then(ensurePrimarySchema)
      .then(() => dropMachineTxAndTransmitters().catch(() => {}))
      .then(loadFromMySQL)
      .catch(() => {});
    return;
  }
  if (TRY_BUTTON_DB) {
    initButtonDB()
      .then(() => ensureButtonMasterSchema())
      .then(() => dropMachineTxAndTransmitters().catch(() => {}))
      .then(refreshLinesFromMaster)
      .catch(() => {});
  }
}

function getState() {
  return state;
}

function upsertMachine({ line, machine, job, good, reject, status, target }) {
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
      target: typeof target === 'number' ? target : (typeof cur.target === 'number' ? cur.target : 0),
      updatedAt: now
    };
  } else {
    arr.push({ line, machine, job: job || 'Unknown', good: good || 0, reject: reject || 0, status: status || 'active', target: typeof target === 'number' ? target : 0, updatedAt: now });
  }
  state.lines[line] = arr;
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
  save();
}

function setLineStatus(line, status) {
  state.meta = state.meta || {};
  const cur = state.meta[line] || {};
  state.meta[line] = { style: cur.style || null, status };
  save();
}

async function tableExists(poolConn, tableName) {
  try {
    const [curDbRows] = await poolConn.query('SELECT DATABASE() AS db');
    const dbname = (Array.isArray(curDbRows) && curDbRows[0] && (curDbRows[0].db || curDbRows[0].DB)) ? curDbRows[0].db : (process.env.BUTTON_DB_NAME || 'button_db');
    const [rows] = await poolConn.query('SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [dbname, tableName]);
    const c = (rows && rows[0] && (rows[0].c || rows[0].C)) || 0;
    return c > 0;
  } catch { return false; }
}

async function dropReferencingForeignKeys(poolConn, targetTable) {
  try {
    const [curDbRows] = await poolConn.query('SELECT DATABASE() AS db');
    const dbname = (Array.isArray(curDbRows) && curDbRows[0] && (curDbRows[0].db || curDbRows[0].DB)) ? curDbRows[0].db : (process.env.BUTTON_DB_NAME || 'button_db');
    const [fkRows] = await poolConn.query(
      'SELECT TABLE_NAME AS tbl, CONSTRAINT_NAME AS fk FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?',
      [dbname, targetTable]
    );
    for (const r of (Array.isArray(fkRows) ? fkRows : [])) {
      const tbl = r.tbl || r.TABLE_NAME;
      const fk = r.fk || r.CONSTRAINT_NAME;
      if (!tbl || !fk) continue;
      try { await poolConn.execute(`ALTER TABLE \`${tbl}\` DROP FOREIGN KEY \`${fk}\``); } catch {}
    }
  } catch {}
}

async function dropTableWithFk(poolConn, tableName) {
  await dropReferencingForeignKeys(poolConn, tableName);
  try { await poolConn.execute(`DROP TABLE IF EXISTS \`${tableName}\``); } catch {}
}

async function dropMasterLineIfExists() {
  try {
    await ensureButtonMasterSchema();
    const poolConn = poolButton;
    const exists = await tableExists(poolConn, 'master_line');
    if (exists) await dropTableWithFk(poolConn, 'master_line');
  } catch {}
}

async function migrateLegacyTables() {
  await ensureButtonMasterSchema();
  const poolConn = poolButton;
  try {
    if (await tableExists(poolConn, 'lines')) {
      const [rows] = await poolConn.query('SELECT DISTINCT id FROM `lines`');
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const name = r.id;
        if (!name) continue;
        try {
          const [ex] = await poolConn.query('SELECT id_line FROM daftar_line WHERE nama_line = ? LIMIT 1', [name]);
          if (!(Array.isArray(ex) && ex.length)) {
            await poolConn.execute('INSERT INTO daftar_line (nama_line) VALUES (?)', [name]);
          }
        } catch {}
      }
    }
  } catch {}
  try {
    if (await tableExists(poolConn, 'merk')) {
      const [rows] = await poolConn.query('SELECT id_merk, name, id_jnsmesin FROM merk');
      for (const r of (Array.isArray(rows) ? rows : [])) {
        try {
          const [ex] = await poolConn.query('SELECT id_merk FROM merk_mesin WHERE id_merk = ? LIMIT 1', [r.id_merk]);
          if (!(Array.isArray(ex) && ex.length)) {
            await poolConn.execute('INSERT INTO merk_mesin (id_merk, name, id_jnsmesin) VALUES (?,?,?)', [r.id_merk, r.name || null, r.id_jnsmesin || null]);
          }
        } catch {}
      }
    }
  } catch {}
  try {
    if (await tableExists(poolConn, 'machines')) {
      const [rows] = await poolConn.query('SELECT DISTINCT job FROM machines');
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const jenisName = r.job ? String(r.job) : null;
        let idJns = null;
        if (jenisName) {
          try {
            const [j] = await poolConn.query('SELECT id_jnsmesin FROM jenis_mesin WHERE name = ? LIMIT 1', [jenisName]);
            if (Array.isArray(j) && j.length) idJns = j[0].id_jnsmesin;
          } catch {}
        }
        try {
          await poolConn.execute('INSERT INTO master_mesin (id_merk, id_jnsmesin, id_kategori) VALUES (?, ?, ?)', [null, idJns || null, null]);
        } catch {}
      }
    }
  } catch {}
  await dropTableWithFk(poolConn, 'machines');
  await dropTableWithFk(poolConn, 'lines');
  await dropTableWithFk(poolConn, 'merk');
  try {
    // Merge master_line into daftar_line if exists, then drop duplicate
    if (await tableExists(poolConn, 'master_line')) {
      const [rows] = await poolConn.query('SELECT nama_line FROM master_line');
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!r.nama_line) continue;
        try {
          const [ex] = await poolConn.query('SELECT id_line FROM daftar_line WHERE nama_line = ? LIMIT 1', [r.nama_line]);
          if (!(Array.isArray(ex) && ex.length)) {
            await poolConn.execute('INSERT INTO daftar_line (nama_line) VALUES (?)', [r.nama_line]);
          }
        } catch {}
      }
      await dropTableWithFk(poolConn, 'master_line');
    }
  } catch {}
  try {
    if (await tableExists(poolConn, 'kategori')) {
      await dropTableWithFk(poolConn, 'kategori');
    }
  } catch {}
  try {
    if (await tableExists(poolConn, 'style_proses_mesin')) {
      await dropTableWithFk(poolConn, 'style_proses_mesin');
    }
  } catch {}
  await dropTableWithFk(poolConn, 'style_orders');
  await dropTableWithFk(poolConn, 'style_processes');
  return { ok: true };
}

async function dropMachineTxAndTransmitters() {
  await ensureButtonMasterSchema();
  const poolConn = poolButton;
  try { await dropTableWithFk(poolConn, 'machine_tx'); } catch {}
  try { await dropTableWithFk(poolConn, 'transmitter'); } catch {}
  return { ok: true };
}


// removed: ensureButtonIoTSchema

module.exports = { seedInitial, getState, getLines, getLine, getLineStyle, setLineStyle, setLineStatus, upsertMachine, incrementMachine, getStateLive, getLinesLive, getLineLive, getLineStyleLive, getLineStatusLive, 
  initMySQL, getMySQLPool,
  initButtonDB, ensureButtonSchema, getButtonPool: () => poolButton,
  ensurePrimarySchema,
  refreshLinesFromMaster,
  getJenisMesinMaster, createJenisMesinMaster, updateJenisMesinMaster, deleteJenisMesinMaster,
  getMerkMaster, createMerkMaster, updateMerkMaster, deleteMerkMaster,
  getProsesProduksi, createProsesProduksi, updateProsesProduksi, deleteProsesProduksi,
  getJenisPakaian, createJenisPakaian, updateJenisPakaian, deleteJenisPakaian,
  getAlurJahitByJenisId, setAlurJahitByJenisId,
  getMasterLine, createMasterLine, updateMasterLine, deleteMasterLine,
  getMasterStyles, updateMasterStyle, deleteMasterStyle,
  listMasterOrderList, createMasterOrderList, updateMasterOrderListByOrc, deleteMasterOrderListByOrc,
  saveStyleOrder, getStyleOrderByLine, addStyleProcess, deleteStyleProcess, renameStyleProcess, addProcessMachines, getMasterOrderSummary,
  deleteProcessMachines, deleteMasterOrderForLine, getMachineTxAssignments, assignMachineTx, unassignMachineTx,
  migrateLegacyTables,
  dropMachineTxAndTransmitters,
  ensureIotSchema, rebuildIotSchema, installIotSeedAndProcedure,
  iotUpsertReceiver, iotUpdateReceiverLastSeen, iotUpsertSummary, iotHandleEvent, iotGetLogs, iotGetStatus, iotGetTransmitters, iotGetAvailableTransmitters,
  iotUnbindTransmitter,
  iotUpdateTransmitterName, iotDeleteTransmitter,
  getIotPool: () => poolIot,
  isButtonDbReady };
async function ensurePrimarySchema() {
  await initMySQL();
}

async function refreshLinesFromMaster() {
  try {
    await ensureButtonMasterSchema();
    await dropMasterLineIfExists();
    const rows = await getMasterLine();
    const names = Array.isArray(rows) ? rows.map(r => r.nama_line).filter(Boolean) : [];
    if (!names.length) return;
    state.list = names;
    const prevLines = state.lines || {};
    const prevMeta = state.meta || {};
    const newLines = { ...prevLines };
    const newMeta = { ...prevMeta };
    for (const lineId of names) {
      const st = (prevMeta[lineId] && prevMeta[lineId].status) ? prevMeta[lineId].status : 'active';
      const style = (prevMeta[lineId] && prevMeta[lineId].style) ? prevMeta[lineId].style : null;
      const processes = (prevMeta[lineId] && prevMeta[lineId].processes) ? prevMeta[lineId].processes : [];
      const defaults = (prevMeta[lineId] && prevMeta[lineId].defaults) ? prevMeta[lineId].defaults : {};
      newMeta[lineId] = { style, status: st, processes, defaults };
      if (!newLines[lineId]) newLines[lineId] = [];
    }
    state.lines = newLines;
    state.meta = newMeta;
    save();
  } catch {}
}

async function saveStyleOrder({ line, category, type, processes }) {
  let okWrite = false;
  if (DB_MYSQL) {
    try {
      await ensurePrimarySchema();
      const now = toSqlDatetime(new Date().toISOString());
      const [rows] = await pool.execute('SELECT id FROM `style_orders` WHERE line_id = ? ORDER BY id DESC LIMIT 1', [line]);
      let orderId;
      if (rows && rows.length) {
        const oid = rows[0].id;
        await pool.execute('UPDATE `style_orders` SET category = ?, type = ?, created_at = ? WHERE id = ?', [category || '', type || '', now, oid]);
        orderId = oid;
      } else {
        const [ins] = await pool.execute('INSERT INTO `style_orders` (line_id, category, type, created_at) VALUES (?,?,?,?)', [line, category || '', type || '', now]);
        orderId = ins.insertId;
      }
      if (Array.isArray(processes) && processes.length) {
        await pool.execute('DELETE FROM `style_processes` WHERE order_id = ?', [orderId]);
        let pos = 0;
        for (const p of processes) {
          await pool.execute('INSERT INTO `style_processes` (order_id, name, position) VALUES (?,?,?)', [orderId, String(p.name || ''), pos++]);
        }
      }
      await pool.execute('INSERT INTO `lines` (id, style, status) VALUES (?,?,?) ON DUPLICATE KEY UPDATE style=VALUES(style)', [line, type || null, 'active']);
      okWrite = true;
    } catch {}
  }
  try {
    await ensureButtonMasterSchema();
    try {
      const now = toSqlDatetime(new Date().toISOString());
      let lineId = await resolveLineIdByName(line);
      if (lineId == null) {
        try {
          const nmLine = String(line || '').trim();
          if (nmLine) {
            const created = await createMasterLine({ nama_line: nmLine });
            lineId = created && created.id_line != null ? created.id_line : null;
          }
        } catch { lineId = null; }
      }
      if (lineId != null) {
        let styleId = null;
        try {
          const [cur] = await poolButton.query('SELECT id_style FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
          styleId = Array.isArray(cur) && cur[0] ? cur[0].id_style : null;
        } catch { styleId = null; }
        if (styleId != null) {
          try { await poolButton.execute('UPDATE master_styles SET category = ?, style_nama = ?, created_at = ? WHERE id_style = ?', [category || '', type || '', now, styleId]); } catch {}
        } else {
          try {
            const [ins] = await poolButton.execute(
              'INSERT INTO master_styles (id_line, category, style_nama, created_at) VALUES (?, ?, ?, ?)',
              [lineId, category || '', type || '', now]
            );
            styleId = ins && ins.insertId ? ins.insertId : null;
          } catch { styleId = null; }
        }
        if (styleId != null) okWrite = true;
        if (styleId != null && Array.isArray(processes) && processes.length) {
          try { await poolButton.execute('DELETE FROM style_proses WHERE id_style = ?', [styleId]); } catch {}
          for (let i = 0; i < processes.length; i++) {
            const nm = String(processes[i].name || '').trim();
            if (!nm) continue;
            try { await poolButton.execute('INSERT INTO style_proses (id_style, nama_proses) VALUES (?, ?)', [styleId, nm]); } catch {}
          }
        }
      }
    } catch (e) { console.error('style_order_write_error', { message: String(e && e.message || e) }); }
  } catch {}
  state.meta = state.meta || {};
  const cur = state.meta[line] || { status: 'active' };
  const nextProcesses = (Array.isArray(processes) && processes.length)
    ? processes.map(p => ({ name: String(p.name || '') }))
    : (Array.isArray(cur.processes) ? cur.processes : []);
  state.meta[line] = { style: type || null, status: cur.status || 'active', processes: nextProcesses, defaults: cur.defaults || {} };
  save();
  if (okWrite) { try { await upsertMasterOrderForLine(line); } catch {} }
  return { ok: okWrite };
}

async function getStyleOrderByLine(line) {
  try {
    await ensureButtonMasterSchema();
    let lineId = null;
    lineId = await resolveLineIdByName(line);
  if (lineId != null) {
      const [so] = await poolButton.query('SELECT id_style, style_nama, category FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
      const styleRow = Array.isArray(so) && so[0] ? so[0] : null;
      if (!styleRow) return { order: null, processes: [] };
      const [sp] = await poolButton.query('SELECT nama_proses FROM style_proses WHERE id_style = ? ORDER BY id_proses ASC', [styleRow.id_style]);
      let processes = (Array.isArray(sp) ? sp : []).map(r => ({ name: r.nama_proses }));
      if (!processes.length) {
        const arr = getLine(line) || [];
        const jobs = Array.from(new Set(arr.map(m => String(m.job || '')).filter(Boolean)));
        if (jobs.length) {
          for (const nm of jobs) {
            try {
              const [p1] = await poolButton.query('SELECT id_proses FROM style_proses WHERE id_style = ? AND nama_proses = ? LIMIT 1', [styleRow.id_style, nm]);
              if (!(Array.isArray(p1) && p1.length)) {
                await poolButton.execute('INSERT INTO style_proses (id_style, nama_proses) VALUES (?, ?)', [styleRow.id_style, nm]);
              }
            } catch {}
          }
          processes = jobs.map(n => ({ name: n }));
          try { await upsertMasterOrderForLine(line); } catch {}
        } else {
          let metaProcs = [];
          let defProcs = [];
          try {
            const curMeta = state.meta && state.meta[line] ? state.meta[line] : null;
            metaProcs = Array.isArray(curMeta && curMeta.processes) ? curMeta.processes.map(p => String(p.name || '')).filter(Boolean) : [];
            defProcs = Object.keys((curMeta && curMeta.defaults) || {}).filter(Boolean);
          } catch {}
          const union = Array.from(new Set([...(metaProcs || []), ...(defProcs || [])]));
          if (union.length) {
            for (const nm of union) {
              try {
                const [p1] = await poolButton.query('SELECT id_proses FROM style_proses WHERE id_style = ? AND nama_proses = ? LIMIT 1', [styleRow.id_style, nm]);
                if (!(Array.isArray(p1) && p1.length)) {
                  await poolButton.execute('INSERT INTO style_proses (id_style, nama_proses) VALUES (?, ?)', [styleRow.id_style, nm]);
                }
              } catch {}
            }
            processes = union.map(n => ({ name: n }));
            try { await upsertMasterOrderForLine(line); } catch {}
          }
        }
      }
      let defaults = {};
      try {
        const cur = state.meta && state.meta[line] ? state.meta[line] : null;
        const map = cur && cur.defaults ? cur.defaults : {};
        defaults = map || {};
      } catch {}
      return { order: { category: styleRow.category || '', type: styleRow.style_nama }, processes, defaults };
    }
  } catch {}
  const curStyle = getLineStyle(line);
  const procs = (state.meta && state.meta[line] && Array.isArray(state.meta[line].processes)) ? state.meta[line].processes : [];
  return { order: curStyle ? { category: '', type: curStyle } : null, processes: procs, defaults: {} };
}

async function addStyleProcess({ line, name }) {
  try {
    await ensureButtonMasterSchema();
    let lineId = await resolveLineIdByName(line);
    if (lineId == null) {
      const nmLine = String(line || '').trim();
      if (nmLine) {
        const created = await createMasterLine({ nama_line: nmLine });
        lineId = created && created.id_line != null ? created.id_line : null;
      }
    }
    if (lineId == null) return { ok: false };
    let styleId = null;
    try {
      const [cur] = await poolButton.query('SELECT id_style FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
      styleId = Array.isArray(cur) && cur[0] ? cur[0].id_style : null;
    } catch {}
    if (styleId == null) {
      const now = toSqlDatetime(new Date().toISOString());
      const [insStyle] = await poolButton.execute('INSERT INTO master_styles (id_line, category, style_nama, created_at) VALUES (?,?,?,?)', [lineId, '', '', now]);
      styleId = insStyle && insStyle.insertId ? insStyle.insertId : null;
    }
    const nm = String(name || '').trim();
    if (!nm || styleId == null) return { ok: false };
    try {
      const [p1] = await poolButton.query('SELECT id_proses FROM style_proses WHERE id_style = ? AND nama_proses = ? LIMIT 1', [styleId, nm]);
      if (!(Array.isArray(p1) && p1.length)) {
        await poolButton.execute('INSERT INTO style_proses (id_style, nama_proses) VALUES (?, ?)', [styleId, nm]);
      }
    } catch {}
    await upsertMasterOrderForLine(line);
    state.meta = state.meta || {};
    const cur = state.meta[line] || { status: 'active' };
    const list = Array.isArray(cur.processes) ? cur.processes.slice() : [];
    if (!list.find(p => String(p.name) === String(nm))) list.push({ name: nm });
    state.meta[line] = { style: cur.style || null, status: cur.status || 'active', processes: list };
    save();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function deleteStyleProcess({ line, name }) {
  try {
    await ensureButtonMasterSchema();
    const lineId = await resolveLineIdByName(line);
    if (lineId == null) return { ok: false };
    let styleId = null;
    try {
      const [cur] = await poolButton.query('SELECT id_style FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
      styleId = Array.isArray(cur) && cur[0] ? cur[0].id_style : null;
    } catch {}
    if (styleId == null) return { ok: false };
    const nm = String(name || '').trim();
    if (!nm) return { ok: false };
    let procId = null;
    try {
      const [p1] = await poolButton.query('SELECT id_proses FROM style_proses WHERE id_style = ? AND nama_proses = ? LIMIT 1', [styleId, nm]);
      if (Array.isArray(p1) && p1.length) procId = p1[0].id_proses;
    } catch {}
    if (procId == null) return { ok: false };
    try { await poolButton.execute('DELETE FROM proses_mesin WHERE id_proses = ?', [procId]); } catch {}
    try { await poolButton.execute('DELETE FROM style_proses WHERE id_proses = ?', [procId]); } catch {}
    await upsertMasterOrderForLine(line);
    state.meta = state.meta || {};
    const cur = state.meta[line] || { status: 'active' };
    const list = Array.isArray(cur.processes) ? cur.processes.slice() : [];
    const out = list.filter(p => String(p.name) !== String(nm));
    state.meta[line] = { style: cur.style || null, status: cur.status || 'active', processes: out };
    save();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function renameStyleProcess({ line, oldName, newName }) {
  try {
    await ensureButtonMasterSchema();
    const lineId = await resolveLineIdByName(line);
    if (lineId == null) return { ok: false };
    let styleId = null;
    try {
      const [cur] = await poolButton.query('SELECT id_style FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
      styleId = Array.isArray(cur) && cur[0] ? cur[0].id_style : null;
    } catch {}
    if (styleId == null) return { ok: false };
    const nmOld = String(oldName || '').trim();
    const nmNew = String(newName || '').trim();
    if (!nmOld || !nmNew) return { ok: false };
    try {
      await poolButton.execute('UPDATE style_proses SET nama_proses = ? WHERE id_style = ? AND nama_proses = ?', [nmNew, styleId, nmOld]);
    } catch {}
    const arr = getLine(line) || [];
    for (const m of arr) {
      if (String(m.job) === String(nmOld)) {
        upsertMachine({ line, machine: m.machine, job: nmNew, good: m.good, reject: m.reject, status: m.status, target: typeof m.target === 'number' ? m.target : 0 });
      }
    }
    await upsertMasterOrderForLine(line);
    state.meta = state.meta || {};
    const cur = state.meta[line] || { status: 'active' };
    const list = Array.isArray(cur.processes) ? cur.processes.slice() : [];
    const out = list.map(p => ({ name: String(p.name) === String(nmOld) ? nmNew : p.name }));
    state.meta[line] = { style: cur.style || null, status: cur.status || 'active', processes: out };
    save();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function addProcessMachines({ line, processName, machineType, qty, target }) {
  const count = Math.max(1, Number(qty) || 1);
  const prefix = `${line}-${processName}-`;
  const existing = getLine(line) || [];
  const kept = existing.filter(m => !(String(m.job) === String(processName) && String(m.machine || '').startsWith(prefix)));
  state.lines = state.lines || {};
  state.lines[line] = kept;
  const arr = state.lines[line] || [];
  let created = 0;
  let idx = 1;
  function nextId() {
    const candidate = `${line}-${processName}-${machineType}-${idx}`;
    idx++;
    return candidate;
  }
  while (created < count) {
    let id = nextId();
    while (arr.find(m => m.machine === id)) { id = nextId(); }
    upsertMachine({ line, machine: id, job: processName || 'Unknown', good: 0, reject: 0, status: 'active', target: Number(target) || 0 });
    created++;
  }
  state.meta = state.meta || {};
  const cur = state.meta[line] || { style: null, status: 'active' };
  const defs = cur.defaults || {};
  defs[processName] = { type: String(machineType || ''), qty: Number(count), target: Number(target) || 0 };
  state.meta[line] = { style: cur.style || null, status: cur.status || 'active', processes: cur.processes || [], defaults: defs };
  save()
  try { await upsertMasterOrderForLine(line); } catch {}
  return { ok: true };
}

async function deleteProcessMachines({ line, processName, machineType }) {
  const arr = getLine(line) || [];
  const prefix = machineType ? `${line}-${processName}-${machineType}-` : `${line}-${processName}-`;
  const out = arr.filter(m => !(String(m.machine || '').startsWith(prefix) && String(m.job) === String(processName)));
  state.lines[line] = out;
  state.meta = state.meta || {};
  const cur = state.meta[line] || { style: null, status: 'active' };
  const defs = cur.defaults || {};
  if (defs[processName] && (!machineType || String(defs[processName].type) === String(machineType))) {
    delete defs[processName];
  }
  state.meta[line] = { style: cur.style || null, status: cur.status || 'active', processes: cur.processes || [], defaults: defs };
  save();
  try { await upsertMasterOrderForLine(line); } catch {}
  return { ok: true };
}

async function deleteMasterOrderForLine(line) {
  try {
    await ensureButtonMasterSchema();
    let lineId = null;
    lineId = await resolveLineIdByName(line);
    if (lineId == null) return { ok: false };
    let styleId = null;
    try {
      const [so] = await poolButton.query('SELECT id_style FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
      if (Array.isArray(so) && so.length) styleId = so[0].id_style;
    } catch {}
    if (styleId != null) {
      try { await poolButton.execute('DELETE FROM style_proses WHERE id_style = ?', [styleId]); } catch {}
      try { await poolButton.execute('DELETE FROM master_styles WHERE id_style = ?', [styleId]); } catch {}
    }
    state.lines[line] = [];
    state.meta = state.meta || {};
    const cur = state.meta[line] || { style: null, status: 'active' };
    state.meta[line] = { style: null, status: cur.status || 'active', processes: [], defaults: {} };
    save();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function upsertMasterOrderForLine(line) {
  try {
    await ensureButtonMasterSchema();
    const poolConn = poolButton;
    const existsMo = await tableExists(poolConn, 'master_orders');
    if (!existsMo) return;
    const lineId = await resolveLineIdByName(line);
    if (lineId == null) return;
    let category = ''; let type = '';
    let styleId = null;
    try {
      const [so] = await poolConn.query('SELECT id_style, category, style_nama FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
      if (Array.isArray(so) && so[0]) { styleId = so[0].id_style; category = so[0].category || ''; type = so[0].style_nama || ''; }
    } catch {}
    let totalProcesses = 0;
    const processNames = [];
    if (styleId != null) {
      try {
        const [sp] = await poolConn.query('SELECT nama_proses FROM style_proses WHERE id_style = ? ORDER BY id_proses ASC', [styleId]);
        for (const r of Array.isArray(sp) ? sp : []) { const nm = r.nama_proses || ''; if (nm) processNames.push(nm); }
        totalProcesses = processNames.length;
      } catch {}
    }
    let totalMachines = 0;
    try {
      const arr = state.lines[line] || [];
      if (processNames.length) {
        for (const nm of processNames) {
          totalMachines += arr.filter(m => String(m.job) === String(nm)).length;
        }
      } else {
        totalMachines = arr.length;
      }
    } catch {}
    const now = toSqlDatetime(new Date().toISOString());
    await poolConn.execute(
      'INSERT INTO master_orders (id_line, category, type, total_processes, total_machines, updated_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE category=VALUES(category), type=VALUES(type), total_processes=VALUES(total_processes), total_machines=VALUES(total_machines), updated_at=VALUES(updated_at)',
      [lineId, category, type, totalProcesses, totalMachines, now]
    );
  } catch {}
}

async function getMasterOrderSummary() {
  try {
    await ensureButtonMasterSchema();
    const rows = await getMasterLine();
    const linesRows = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => Number(a.id_line || 0) - Number(b.id_line || 0));
    const out = [];
    for (const lr of Array.isArray(linesRows) ? linesRows : []) {
      const line = lr.nama_line;
      const idLine = lr.id_line;
      let styleId = null;
      let category = ''; let type = '';
      try {
        const [so] = await poolButton.query('SELECT id_style, category, style_nama FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [idLine]);
        if (Array.isArray(so) && so.length) { styleId = so[0].id_style; category = so[0].category || ''; type = so[0].style_nama || ''; }
      } catch {}
      const procDetails = [];
      let totalProcesses = 0;
      let totalMachines = 0;
      const defs = (state.meta && state.meta[line] && state.meta[line].defaults) ? state.meta[line].defaults : {};
      const arr = getLine(line) || [];
      if (styleId != null) {
        try {
          const [sp] = await poolButton.query('SELECT nama_proses FROM style_proses WHERE id_style = ? ORDER BY id_proses ASC', [styleId]);
          let procs = Array.isArray(sp) ? sp : [];
          if (!procs.length && arr.length) {
            const names = Array.from(new Set(arr.map(m => String(m.job || '')).filter(Boolean)));
            totalProcesses = names.length;
            for (const name of names) {
              const cnt = arr.filter(m => String(m.job) === String(name)).length;
              procDetails.push({ name, machines: cnt });
            }
            totalMachines = arr.length;
          } else if (!procs.length && Object.keys(defs || {}).length) {
            const names = Object.keys(defs);
            totalProcesses = names.length;
            for (const name of names) {
              const qty = Number(defs[name].qty || 0);
              procDetails.push({ name, machines: qty });
              totalMachines += qty;
            }
          } else {
            totalProcesses = procs.length;
            for (const p of procs) {
              const name = p.nama_proses || '';
              const qtyDefault = defs && defs[name] ? Number(defs[name].qty || 0) : 0;
              const qtyLive = arr.filter(m => String(m.job) === String(name)).length;
              const qty = qtyDefault || qtyLive;
              procDetails.push({ name, machines: qty });
              totalMachines += qty;
            }
          }
        } catch {}
      }
      out.push({ line, category, type, totalProcesses, totalMachines, processes: procDetails });
    }
    return out;
  } catch {}
  const names = getLines();
  const out = [];
  for (const line of names) {
    const style = getLineStyle(line) || '';
    const arr = getLine(line) || [];
    out.push({ line, category: '', type: style, totalProcesses: 0, totalMachines: arr.length, processes: [] });
  }
  return out;
}

async function getMachineTxAssignments(line) {
  try {
    await ensureButtonMasterSchema();
    const [rows] = await poolButton.query('SELECT line, machine, tx, created_at FROM machine_tx ' + (line ? 'WHERE line = ?' : '') + ' ORDER BY line, machine', line ? [line] : []);
    return (Array.isArray(rows) ? rows : []).map(r => ({ line: r.line, machine: r.machine, tx: r.tx, created_at: r.created_at }));
  } catch {
    return [];
  }
}

async function assignMachineTx({ line, machine, tx }) {
  try {
    await ensureButtonMasterSchema();
    await ensureIotSchema();
    const now = toSqlDatetime(new Date().toISOString());
    const [exTx] = await poolIot.query('SELECT transmitter_id FROM iot_transmitters WHERE transmitter_id = ? LIMIT 1', [tx]);
    const ok = Array.isArray(exTx) && exTx.length;
    if (!ok) return { ok: false, error: 'tx_not_found' };
    try {
      await poolButton.execute('INSERT INTO machine_tx (line, machine, tx, created_at) VALUES (?,?,?,?)', [line, machine, tx, now]);
    } catch (e) {
      return { ok: false, error: 'tx_in_use' };
    }
    const arr = state.lines[line] || [];
    for (let i = 0; i < arr.length; i++) { if (arr[i].machine === machine) { arr[i] = { ...arr[i], tx }; break; } }
    state.lines[line] = arr;
    save();
    return { ok: true };
  } catch {
    return { ok: false, error: 'db_error' };
  }
}

async function unassignMachineTx({ line, machine }) {
  try {
    await ensureButtonMasterSchema();
    let tx = null;
    try {
      const [rows] = await poolButton.query('SELECT tx FROM machine_tx WHERE line = ? AND machine = ? LIMIT 1', [line, machine]);
      tx = Array.isArray(rows) && rows[0] ? rows[0].tx : null;
    } catch {}
    await poolButton.execute('DELETE FROM machine_tx WHERE line = ? AND machine = ?', [line, machine]);
    const arr = state.lines[line] || [];
    for (let i = 0; i < arr.length; i++) { if (arr[i].machine === machine) { const cur = { ...arr[i] }; delete cur.tx; arr[i] = cur; break; } }
    state.lines[line] = arr;
    save();
    return { ok: true, tx };
  } catch {
    return { ok: false, error: 'db_error' };
  }
}

async function iotGetTransmitters() {
  try {
    await ensureIotSchema();
    const [rows] = await poolIot.query('SELECT t.transmitter_id AS tx, r.mac_address AS mac_address FROM iot_transmitters t LEFT JOIN iot_receivers r ON r.receiver_id = t.receiver_id ORDER BY t.transmitter_id ASC');
    const [sumRows] = await poolIot.query('SELECT tx, output, reject, output_total, reject_total FROM iot_summary');
    const sumMap = {};
    for (const s of Array.isArray(sumRows) ? sumRows : []) { sumMap[String(s.tx)] = s; }
    return (Array.isArray(rows) ? rows : []).map(r => {
      const m = sumMap[String(r.tx)] || {};
      return { tx: r.tx, output: m.output || 0, reject: m.reject || 0, output_total: m.output_total || 0, reject_total: m.reject_total || 0, mac_address: r.mac_address || null };
    });
  } catch {
    return [];
  }
}

async function iotGetAvailableTransmitters() {
  try {
    const all = await iotGetTransmitters();
    await ensureButtonMasterSchema();
    const [rows] = await poolButton.query('SELECT tx FROM machine_tx');
    const used = new Set((Array.isArray(rows) ? rows : []).map(r => String(r.tx)));
    return all.filter(r => !used.has(String(r.tx)));
  } catch {
    return [];
  }
}

async function iotUnbindTransmitter(tx) {
  await ensureIotSchema();
  if (!IOT_DB_READY) return { ok: false };
  const key = String(tx || '').trim();
  if (!key) return { ok: false };
  try {
    await poolIot.execute('UPDATE iot_transmitters SET receiver_id = NULL WHERE transmitter_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci', [key]);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function iotUpdateTransmitterName(tx, name) {
  await ensureIotSchema();
  const key = String(tx || '').trim();
  const nm = String(name || '').trim();
  if (!IOT_DB_READY || !key) return { ok: false };
  try {
    await poolIot.execute('UPDATE iot_transmitters SET name = ? WHERE transmitter_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci', [nm || null, key]);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function iotDeleteTransmitter(tx) {
  await ensureIotSchema();
  const key = String(tx || '').trim();
  if (!IOT_DB_READY || !key) return { ok: false };
  const conn = await poolIot.getConnection();
  try {
    await conn.beginTransaction();
    try { await conn.execute('DELETE FROM iot_summary WHERE tx = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci', [key]); } catch {}
    try { await conn.execute('DELETE FROM iot_transmitters WHERE transmitter_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci', [key]); } catch {}
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }
  try {
    await ensureButtonMasterSchema();
    await poolButton.execute('DELETE FROM machine_tx WHERE tx = ?', [key]);
  } catch {}
  return { ok: true };
}

function ensureIotState() {
  state.iot = state.iot || { receivers: [], summary: {}, logs: [], resets: [], event_ids: [] };
}

async function iotGetCurrentDbName(conn) {
  const [rows] = await conn.query('SELECT DATABASE() AS db');
  const db = Array.isArray(rows) && rows[0] ? (rows[0].db || rows[0].DB || rows[0].database) : null;
  return db ? String(db) : null;
}

async function iotDropAllForeignKeys(conn, tableName) {
  const db = await iotGetCurrentDbName(conn);
  if (!db) return;
  let rows = [];
  try {
    const [r] = await conn.query(
      'SELECT DISTINCT CONSTRAINT_NAME AS name FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL',
      [db, String(tableName)]
    );
    rows = Array.isArray(r) ? r : [];
  } catch { return; }
  const names = Array.from(new Set(rows.map(x => x.name).filter(Boolean)));
  for (const fk of names) {
    try { await conn.execute(`ALTER TABLE \`${String(tableName)}\` DROP FOREIGN KEY \`${String(fk)}\``); } catch {}
  }
}

async function iotEnsureColumn(conn, tableName, columnName, sqlType) {
  const db = await iotGetCurrentDbName(conn);
  if (!db) return;
  try {
    const [rows] = await conn.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [db, String(tableName), String(columnName)]
    );
    const exists = Array.isArray(rows) && rows.length;
    if (!exists) {
      await conn.execute(`ALTER TABLE \`${String(tableName)}\` ADD COLUMN \`${String(columnName)}\` ${sqlType}`);
    }
  } catch {}
}

async function ensureIotSchema() {
  await initIotDB();
  if (!IOT_DB_READY) return;
  const conn = poolIot;
  await conn.execute(
    'CREATE TABLE IF NOT EXISTS iot_receivers (' +
    'receiver_id VARCHAR(16) PRIMARY KEY, ' +
    'mac_address VARCHAR(32) NULL, ' +
    'name VARCHAR(64) NULL, ' +
    'auth_token VARCHAR(128) NULL, ' +
    'last_seen DATETIME(3) NULL, ' +
    'created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), ' +
    'UNIQUE KEY uniq_receivers_mac (mac_address)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
  await conn.execute(
    'CREATE TABLE IF NOT EXISTS iot_transmitters (' +
    'transmitter_id VARCHAR(64) PRIMARY KEY, ' +
    'name VARCHAR(128) NULL, ' +
    'receiver_id VARCHAR(16) NULL, ' +
    'created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), ' +
    'updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
    'INDEX idx_tx_rx (receiver_id)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
  await conn.execute(
    'CREATE TABLE IF NOT EXISTS iot_summary (' +
    'tx VARCHAR(64) PRIMARY KEY, ' +
    'output INT NOT NULL DEFAULT 0, ' +
    'reject INT NOT NULL DEFAULT 0, ' +
    'output_total INT NOT NULL DEFAULT 0, ' +
    'reject_total INT NOT NULL DEFAULT 0, ' +
    'updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
  await conn.execute(
    'CREATE TABLE IF NOT EXISTS iot_logs (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY, ' +
    'rx VARCHAR(16) NULL, ' +
    'tx VARCHAR(64) NULL, ' +
    'type VARCHAR(16) NOT NULL, ' +
    'value_output INT NULL, ' +
    'value_reject INT NULL, ' +
    'event_id VARCHAR(64) NULL UNIQUE, ' +
    'timestamp DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), ' +
    'INDEX idx_logs_tx_ts (tx, timestamp), ' +
    'INDEX idx_logs_rx_ts (rx, timestamp)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
  await conn.execute(
    'CREATE TABLE IF NOT EXISTS iot_resets (' +
    'id BIGINT AUTO_INCREMENT PRIMARY KEY, ' +
    'tx VARCHAR(64) NOT NULL, ' +
    'prev_output INT NOT NULL, ' +
    'prev_reject INT NOT NULL, ' +
    'start_time DATETIME(3) NULL, ' +
    'timestamp DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), ' +
    'INDEX idx_resets_tx_ts (tx, timestamp)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
  try { await iotDropAllForeignKeys(conn, 'iot_logs'); } catch {}
  try { await iotDropAllForeignKeys(conn, 'iot_resets'); } catch {}
  try { await iotDropAllForeignKeys(conn, 'iot_transmitters'); } catch {}
  try { await iotDropAllForeignKeys(conn, 'iot_receivers'); } catch {}
  try { await iotEnsureColumn(conn, 'iot_resets', 'start_time', 'DATETIME(3) NULL'); } catch {}
  if (!IOT_PROC_READY) {
    try { await ensureIotProcedure(); } catch {}
  }
}

async function rebuildIotSchema(customSql) {
  await initIotDB();
  if (!IOT_DB_READY) return;
  const conn = poolIot;
  try {
    await dropTableWithFk(conn, 'iot_resets');
    await dropTableWithFk(conn, 'iot_logs');
    await dropTableWithFk(conn, 'iot_summary');
    await dropTableWithFk(conn, 'iot_transmitters');
    await dropTableWithFk(conn, 'iot_receivers');
    const sql = (customSql != null && String(customSql).trim().length) ? String(customSql) : null;
    if (sql) {
      const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
      for (const q of stmts) { await conn.execute(q); }
    } else {
      await conn.execute(
        'CREATE TABLE iot_receivers (' +
        'receiver_id VARCHAR(16) PRIMARY KEY, ' +
        'mac_address VARCHAR(32) NULL, ' +
        'name VARCHAR(64) NULL, ' +
        'auth_token VARCHAR(128) NULL, ' +
        'last_seen DATETIME(3) NULL, ' +
        'created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), ' +
        'UNIQUE KEY uniq_receivers_mac (mac_address)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
      );
      await conn.execute(
        'CREATE TABLE iot_transmitters (' +
        'transmitter_id VARCHAR(64) PRIMARY KEY, ' +
        'name VARCHAR(128) NULL, ' +
        'receiver_id VARCHAR(16) NULL, ' +
        'created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), ' +
        'updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), ' +
        'INDEX idx_tx_rx (receiver_id)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
      );
      await conn.execute(
        'CREATE TABLE iot_summary (' +
        'tx VARCHAR(64) PRIMARY KEY, ' +
        'output INT NOT NULL DEFAULT 0, ' +
        'reject INT NOT NULL DEFAULT 0, ' +
        'output_total INT NOT NULL DEFAULT 0, ' +
        'reject_total INT NOT NULL DEFAULT 0, ' +
        'updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
      );
      await conn.execute(
        'CREATE TABLE iot_logs (' +
        'id BIGINT AUTO_INCREMENT PRIMARY KEY, ' +
        'rx VARCHAR(16) NULL, ' +
        'tx VARCHAR(64) NULL, ' +
        'type VARCHAR(16) NOT NULL, ' +
        'value_output INT NULL, ' +
        'value_reject INT NULL, ' +
        'event_id VARCHAR(64) NULL UNIQUE, ' +
        'timestamp DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), ' +
        'INDEX idx_logs_tx_ts (tx, timestamp), ' +
        'INDEX idx_logs_rx_ts (rx, timestamp)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
      );
      await conn.execute(
        'CREATE TABLE iot_resets (' +
        'id BIGINT AUTO_INCREMENT PRIMARY KEY, ' +
        'tx VARCHAR(64) NOT NULL, ' +
        'prev_output INT NOT NULL, ' +
        'prev_reject INT NOT NULL, ' +
        'start_time DATETIME(3) NULL, ' +
        'timestamp DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), ' +
        'INDEX idx_resets_tx_ts (tx, timestamp)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
      );
    }
  } catch (e) {
    throw e;
  }
}

async function installIotSeedAndProcedure(seedSql, procSql) {
  await initIotDB();
  if (!IOT_DB_READY) return;
  const conn = poolIot;
  const seed = (seedSql != null && String(seedSql).trim().length) ? String(seedSql) : null;
  const proc = (procSql != null && String(procSql).trim().length) ? String(procSql) : null;
  if (seed) {
    const cleaned = seed.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    const stmts = cleaned.split(';').map(s => s.trim()).filter(Boolean);
    for (const q of stmts) { await conn.execute(q); }
  }
  if (proc) {
    const cleaned = proc.replace(/DELIMITER\s+.*/gi, '').replace(/\/\/\s*/g, '').trim();
    await conn.query(cleaned);
  }
}

async function ensureIotProcedure() {
  await initIotDB();
  if (!IOT_DB_READY) return;
  try {
    await poolIot.execute('DROP PROCEDURE IF EXISTS sp_handle_event');
    const procSql =
      "CREATE PROCEDURE sp_handle_event(" +
      "  IN p_tx VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci," +
      "  IN p_rx VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci," +
      "  IN p_type VARCHAR(16)," +
      "  IN p_value_output INT," +
      "  IN p_value_reject INT," +
      "  IN p_event_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" +
      ") BEGIN " +
      "  DECLARE v_prev_output INT DEFAULT 0; " +
      "  DECLARE v_prev_reject INT DEFAULT 0; " +
      "  DECLARE v_out INT DEFAULT 0; " +
      "  DECLARE v_rej INT DEFAULT 0; " +
      "  DECLARE v_dup INT DEFAULT 0; " +
      "  START TRANSACTION; " +
      "  IF p_event_id IS NOT NULL AND p_event_id <> '' THEN " +
      "    SELECT COUNT(*) INTO v_dup FROM iot_logs WHERE event_id = CONVERT(p_event_id USING utf8mb4) COLLATE utf8mb4_unicode_ci; " +
      "  END IF; " +
      "  INSERT INTO iot_summary (tx, output, reject, output_total, reject_total) VALUES (CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci, 0, 0, 0, 0) ON DUPLICATE KEY UPDATE tx = tx; " +
      "  INSERT INTO iot_transmitters (transmitter_id, name, receiver_id) VALUES (CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci, NULL, CONVERT(p_rx USING utf8mb4) COLLATE utf8mb4_unicode_ci) ON DUPLICATE KEY UPDATE receiver_id = VALUES(receiver_id); " +
      "  IF v_dup = 0 THEN " +
      "    IF p_type = 'output' THEN " +
      "      IF p_value_output IS NULL THEN " +
      "        UPDATE iot_summary SET output = output + 1 WHERE tx = CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci; " +
      "      ELSE " +
      "        UPDATE iot_summary SET output = GREATEST(output, p_value_output) WHERE tx = CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci; " +
      "      END IF; " +
      "      INSERT INTO iot_logs (rx, tx, type, value_output, event_id) VALUES (CONVERT(p_rx USING utf8mb4) COLLATE utf8mb4_unicode_ci, CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci, 'output', p_value_output, CONVERT(p_event_id USING utf8mb4) COLLATE utf8mb4_unicode_ci); " +
      "    ELSEIF p_type = 'reject' THEN " +
      "      IF p_value_reject IS NULL THEN " +
      "        UPDATE iot_summary SET reject = reject + 1 WHERE tx = CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci; " +
      "      ELSE " +
      "        UPDATE iot_summary SET reject = GREATEST(reject, p_value_reject) WHERE tx = CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci; " +
      "      END IF; " +
      "      INSERT INTO iot_logs (rx, tx, type, value_reject, event_id) VALUES (CONVERT(p_rx USING utf8mb4) COLLATE utf8mb4_unicode_ci, CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci, 'reject', p_value_reject, CONVERT(p_event_id USING utf8mb4) COLLATE utf8mb4_unicode_ci); " +
      "    ELSEIF p_type = 'reset' THEN " +
      "      SELECT output, reject INTO v_prev_output, v_prev_reject FROM iot_summary WHERE tx = CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE; " +
      "      SET v_out = GREATEST(IFNULL(v_prev_output,0), IFNULL(p_value_output,0)); " +
      "      SET v_rej = GREATEST(IFNULL(v_prev_reject,0), IFNULL(p_value_reject,0)); " +
      "      INSERT INTO iot_resets (tx, prev_output, prev_reject) VALUES (CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci, v_out, v_rej); " +
      "      INSERT INTO iot_logs (rx, tx, type, value_output, value_reject, event_id) VALUES (CONVERT(p_rx USING utf8mb4) COLLATE utf8mb4_unicode_ci, CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci, 'reset', v_out, v_rej, CONVERT(p_event_id USING utf8mb4) COLLATE utf8mb4_unicode_ci); " +
      "      UPDATE iot_summary SET output_total = output_total + v_out, reject_total = reject_total + v_rej, output = 0, reject = 0 WHERE tx = CONVERT(p_tx USING utf8mb4) COLLATE utf8mb4_unicode_ci; " +
      "    END IF; " +
      "  END IF; " +
      "  COMMIT; " +
      "END";
    await poolIot.query(procSql);
    IOT_PROC_READY = true;
  } catch (e) {
    const msg = String(e && e.message || e || '');
    if (!/already\s+exists|exists/i.test(msg)) throw e;
  }
}

function mapReceiverIdFromTx(tx) {
  const s = String(tx || '').trim();
  const n = parseInt(s.replace(/\D/g, ''), 10);
  if (!Number.isFinite(n)) return 'RX01';
  if (n >= 11 && n <= 20) return 'RX02';
  if (n >= 21 && n <= 30) return 'RX03';
  return 'RX01';
}

async function iotEnsureReceiverIdForMac(conn, mac) {
  const m = String(mac || '').trim();
  if (!m) return null;
  const [rows] = await conn.query('SELECT receiver_id FROM iot_receivers WHERE mac_address = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci LIMIT 1', [m]);
  const found = Array.isArray(rows) && rows[0] ? rows[0].receiver_id : null;
  if (found) return String(found);
  const [usedRows] = await conn.query('SELECT receiver_id FROM iot_receivers WHERE receiver_id IN ("RX01","RX02","RX03")');
  const used = new Set((Array.isArray(usedRows) ? usedRows : []).map(r => String(r.receiver_id)));
  const candidates = ['RX01', 'RX02', 'RX03'];
  const pick = candidates.find(x => !used.has(x)) || 'RX01';
  await conn.execute(
    'INSERT INTO iot_receivers (receiver_id, mac_address, name, last_seen) VALUES (?, ?, NULL, NOW(3)) ' +
    'ON DUPLICATE KEY UPDATE mac_address = VALUES(mac_address), last_seen = NOW(3)',
    [pick, m]
  );
  return pick;
}

async function iotUpsertReceiver(mac, name) {
  ensureIotState();
  await ensureIotSchema();
  if (IOT_DB_READY) {
    const m = String(mac || '').trim();
    const conn = await poolIot.getConnection();
    try {
      const rxId = await iotEnsureReceiverIdForMac(conn, m);
      if (name != null) {
        await conn.execute(
          'UPDATE iot_receivers SET name = ? WHERE receiver_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci',
          [String(name), rxId]
        );
      }
      const [rows] = await conn.query(
        'SELECT receiver_id, mac_address, name, last_seen FROM iot_receivers WHERE receiver_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci LIMIT 1',
        [rxId]
      );
      return Array.isArray(rows) && rows[0] ? rows[0] : { receiver_id: rxId, mac_address: m, name: name || null, last_seen: null };
    } finally {
      conn.release();
    }
  } else {
    const rx = state.iot.receivers.find(r => String(r.mac_address) === String(mac));
    if (rx) { if (name != null) rx.name = name; return rx; }
    const row = { mac_address: String(mac), name: name || null, last_seen: null };
    state.iot.receivers.push(row);
    save();
    return row;
  }
}

async function iotUpdateReceiverLastSeen(mac) {
  ensureIotState();
  await ensureIotSchema();
  if (IOT_DB_READY) {
    const m = String(mac || '').trim();
    const conn = await poolIot.getConnection();
    try {
      const rxId = await iotEnsureReceiverIdForMac(conn, m);
      await conn.execute(
        'UPDATE iot_receivers SET last_seen = NOW(3) WHERE receiver_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci',
        [rxId]
      );
      const [rows] = await conn.query(
        'SELECT receiver_id, mac_address, name, last_seen FROM iot_receivers WHERE receiver_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci LIMIT 1',
        [rxId]
      );
      return Array.isArray(rows) && rows[0] ? rows[0] : { receiver_id: rxId, mac_address: m, name: null, last_seen: new Date().toISOString().slice(0, 19).replace('T', ' ') };
    } finally {
      conn.release();
    }
  } else {
    const rx = state.iot.receivers.find(r => String(r.mac_address) === String(mac));
    const ts = Date.now();
    if (rx) { rx.last_seen = ts; save(); return rx; }
    const row = { mac_address: String(mac), name: null, last_seen: ts };
    state.iot.receivers.push(row);
    save();
    return row;
  }
}

async function iotUpdateReceiverName(mac, name) {
  ensureIotState();
  await ensureIotSchema();
  const m = String(mac || '').trim();
  const nm = String(name || '').trim();
  if (!m) return { ok: false };
  if (IOT_DB_READY) {
    const conn = await poolIot.getConnection();
    try {
      const rxId = await iotEnsureReceiverIdForMac(conn, m);
      await conn.execute(
        'UPDATE iot_receivers SET name = ? WHERE receiver_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci',
        [nm || null, rxId]
      );
    } finally {
      conn.release();
    }
    return { ok: true };
  } else {
    const rx = state.iot.receivers.find(r => String(r.mac_address) === String(m));
    if (rx) { rx.name = nm || null; save(); return { ok: true }; }
    state.iot.receivers.push({ mac_address: m, name: nm || null, last_seen: null });
    save();
    return { ok: true };
  }
}

async function iotDeleteReceiver(mac) {
  ensureIotState();
  await ensureIotSchema();
  const m = String(mac || '').trim();
  if (!m) return { ok: false };
  if (IOT_DB_READY) {
    try { await poolIot.execute('DELETE FROM iot_receivers WHERE mac_address = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci', [m]); } catch {}
    return { ok: true };
  } else {
    const idx = state.iot.receivers.findIndex(r => String(r.mac_address) === String(m));
    if (idx >= 0) { state.iot.receivers.splice(idx, 1); save(); return { ok: true }; }
    return { ok: true };
  }
}

async function iotUpsertSummary(tx, receiver_mac) {
  ensureIotState();
  await ensureIotSchema();
  const key = String(tx || '').trim();
  if (IOT_DB_READY) {
    await poolIot.execute('INSERT INTO iot_summary (tx, output, reject, output_total, reject_total) VALUES (?, 0, 0, 0, 0) ON DUPLICATE KEY UPDATE tx = VALUES(tx)', [key]);
    const [rows] = await poolIot.query('SELECT tx, output, reject, output_total, reject_total FROM iot_summary WHERE tx = ? LIMIT 1', [key]);
    const cur = Array.isArray(rows) && rows[0] ? rows[0] : { tx: key, output: 0, reject: 0, output_total: 0, reject_total: 0 };
    return cur;
  } else {
    const cur = state.iot.summary[key] || { tx: key, name: null, receiver_mac: null, output: 0, reject: 0, output_total: 0, reject_total: 0, updated_at: null };
    if (receiver_mac != null) cur.receiver_mac = String(receiver_mac);
    cur.updated_at = Date.now();
    state.iot.summary[key] = cur;
    save();
    return cur;
  }
}

async function iotHandleEvent(tx, receiver_mac, type, payload) {
  ensureIotState();
  await ensureIotSchema();
  const p = payload || {};
  const m = String(receiver_mac || '').trim();
  const t = String(tx || '').trim();
  const eid = (p.event_id != null && String(p.event_id).trim().length) ? String(p.event_id).trim() : null;
  if (IOT_DB_READY) {
    const conn = await poolIot.getConnection();
    try {
      await conn.beginTransaction();
      let rxId = null;
      if (m) {
        try { rxId = await iotEnsureReceiverIdForMac(conn, m); } catch {}
      }
      if (!rxId) rxId = mapReceiverIdFromTx(t);
      try { await conn.execute('UPDATE iot_receivers SET last_seen = NOW(3) WHERE receiver_id = CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci', [rxId]); } catch {}
      try { await conn.execute('INSERT INTO iot_transmitters (transmitter_id, name, receiver_id) VALUES (?, NULL, ?) ON DUPLICATE KEY UPDATE receiver_id = COALESCE(VALUES(receiver_id), receiver_id)', [t, rxId]); } catch {}
      await conn.execute('INSERT INTO iot_summary (tx, output, reject, output_total, reject_total) VALUES (?, 0, 0, 0, 0) ON DUPLICATE KEY UPDATE tx = VALUES(tx)', [t]);

      if (eid) {
        try {
          const [dup] = await conn.query('SELECT id FROM iot_logs WHERE event_id = ? LIMIT 1', [eid]);
          if (Array.isArray(dup) && dup[0]) {
            await conn.commit();
            const [rows] = await conn.query('SELECT tx, output, reject, output_total, reject_total FROM iot_summary WHERE tx = ? LIMIT 1', [t]);
            return Array.isArray(rows) && rows[0] ? rows[0] : { tx: t, output: 0, reject: 0, output_total: 0, reject_total: 0 };
          }
        } catch {}
      }

      if (type === 'output') {
        await conn.execute('UPDATE iot_summary SET output = output + 1, output_total = output_total + 1 WHERE tx = ?', [t]);
        try { await conn.execute('INSERT INTO iot_logs (rx, tx, type, event_id) VALUES (?, ?, ?, ?)', [rxId, t, 'output', eid]); } catch {}
      } else if (type === 'reject') {
        await conn.execute('UPDATE iot_summary SET reject = reject + 1, reject_total = reject_total + 1 WHERE tx = ?', [t]);
        try { await conn.execute('INSERT INTO iot_logs (rx, tx, type, event_id) VALUES (?, ?, ?, ?)', [rxId, t, 'reject', eid]); } catch {}
      } else if (type === 'reset') {
        const snapOut = (p.output != null ? Number(p.output) : (p.value_output != null ? Number(p.value_output) : null));
        const snapRej = (p.reject != null ? Number(p.reject) : (p.value_reject != null ? Number(p.value_reject) : null));
        let prevOut = null;
        let prevRej = null;
        if (Number.isFinite(snapOut) || Number.isFinite(snapRej)) {
          prevOut = Number.isFinite(snapOut) ? snapOut : 0;
          prevRej = Number.isFinite(snapRej) ? snapRej : 0;
        } else {
          const [sumRows] = await conn.query('SELECT output, reject FROM iot_summary WHERE tx = ? LIMIT 1 FOR UPDATE', [t]);
          const cur = Array.isArray(sumRows) && sumRows[0] ? sumRows[0] : { output: 0, reject: 0 };
          prevOut = Number(cur.output || 0) || 0;
          prevRej = Number(cur.reject || 0) || 0;
        }
        try { await conn.execute('INSERT INTO iot_resets (tx, prev_output, prev_reject, start_time) VALUES (?, ?, ?, NULL)', [t, prevOut, prevRej]); }
        catch { try { await conn.execute('INSERT INTO iot_resets (tx, prev_output, prev_reject) VALUES (?, ?, ?)', [t, prevOut, prevRej]); } catch {} }
        try { await conn.execute('INSERT INTO iot_logs (rx, tx, type, value_output, value_reject, event_id) VALUES (?, ?, ?, ?, ?, ?)', [rxId, t, 'reset', prevOut, prevRej, eid]); } catch {}
        await conn.execute('UPDATE iot_summary SET output = 0, reject = 0 WHERE tx = ?', [t]);
      }
      await conn.commit();
      const [rows] = await conn.query('SELECT tx, output, reject, output_total, reject_total FROM iot_summary WHERE tx = ? LIMIT 1', [t]);
      return Array.isArray(rows) && rows[0] ? rows[0] : { tx: t, output: 0, reject: 0, output_total: 0, reject_total: 0 };
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }
  } else {
    await iotUpsertReceiver(m, null);
    await iotUpdateReceiverLastSeen(m);
    if (eid) {
      const seen = new Set(Array.isArray(state.iot.event_ids) ? state.iot.event_ids : []);
      if (seen.has(eid)) {
        const sum0 = await iotUpsertSummary(t, m);
        return sum0;
      }
    }
    const sum = await iotUpsertSummary(t, m);
    if (type === 'output') {
      sum.output = Number(sum.output || 0) + 1;
      sum.output_total = Number(sum.output_total || 0) + 1;
      state.iot.logs.unshift({ id: `${Date.now()}-${Math.random()}`, rx: m, tx: t, type: 'output', value_output: 1, value_reject: 0, event_id: eid || null, timestamp: Date.now() });
    } else if (type === 'reject') {
      sum.reject = Number(sum.reject || 0) + 1;
      sum.reject_total = Number(sum.reject_total || 0) + 1;
      state.iot.logs.unshift({ id: `${Date.now()}-${Math.random()}`, rx: m, tx: t, type: 'reject', value_output: 0, value_reject: 1, event_id: eid || null, timestamp: Date.now() });
    } else if (type === 'reset') {
      const snapOut = (p.output != null ? Number(p.output) : (p.value_output != null ? Number(p.value_output) : null));
      const snapRej = (p.reject != null ? Number(p.reject) : (p.value_reject != null ? Number(p.value_reject) : null));
      const out = (Number.isFinite(snapOut) ? snapOut : (Number(sum.output || 0) || 0));
      const rej = (Number.isFinite(snapRej) ? snapRej : (Number(sum.reject || 0) || 0));
      state.iot.resets.unshift({ id: `${Date.now()}-${Math.random()}`, tx: t, prev_output: out, prev_reject: rej, start_time: null, event_id: eid || null, timestamp: Date.now() });
      state.iot.logs.unshift({ id: `${Date.now()}-${Math.random()}`, rx: m, tx: t, type: 'reset', value_output: out, value_reject: rej, event_id: eid || null, timestamp: Date.now() });
      sum.output = 0;
      sum.reject = 0;
    }
    sum.updated_at = Date.now();
    if (eid) {
      const arr = Array.isArray(state.iot.event_ids) ? state.iot.event_ids : [];
      arr.push(eid);
      if (arr.length > 10000) arr.splice(0, arr.length - 10000);
      state.iot.event_ids = arr;
    }
    save();
    return sum;
  }
}


async function iotGetLogs(limit = 200) {
  ensureIotState();
  await ensureIotSchema();
  const n = Math.max(1, Number(limit) || 200);
  if (IOT_DB_READY) {
    const [rows] = await poolIot.query(
      'SELECT l.id, COALESCE(r.mac_address, l.rx) AS rx, l.tx, l.type, l.value_output, l.value_reject, l.timestamp ' +
      'FROM iot_logs l LEFT JOIN iot_receivers r ON r.receiver_id = l.rx ' +
      'ORDER BY l.timestamp DESC LIMIT ?',
      [n]
    );
    return Array.isArray(rows) ? rows : [];
  } else {
    const arr = Array.isArray(state.iot.logs) ? state.iot.logs.slice() : [];
    arr.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    return arr.slice(0, n);
  }
}

async function iotGetStatus(thresholdMs = 10000) {
  ensureIotState();
  await ensureIotSchema();
  if (IOT_DB_READY) {
    const [rows] = await poolIot.query(
      'SELECT r.mac_address, r.name, r.last_seen, ' +
      '  (SELECT MAX(l.timestamp) FROM iot_logs l WHERE l.rx = r.receiver_id) AS last_event ' +
      'FROM iot_receivers r WHERE r.mac_address IS NOT NULL AND r.mac_address <> "" ' +
      'ORDER BY COALESCE(last_event, r.last_seen) DESC'
    );
    const now = Date.now();
    return (Array.isArray(rows) ? rows : []).map(r => {
      const lastSeen = r.last_seen ? new Date(r.last_seen).getTime() : null;
      const lastEvent = r.last_event ? new Date(r.last_event).getTime() : null;
      const last = lastEvent != null ? lastEvent : lastSeen;
      const connected = last != null && (now - last) <= thresholdMs;
      return { mac_address: r.mac_address, name: r.name, last_seen: last, connected };
    });
  } else {
    const now = Date.now();
    const recs = (state.iot.receivers || []).map(r => {
      const lastSeen = Number(r.last_seen || 0) || null;
      const lastEvent = (() => {
        const arr = Array.isArray(state.iot.logs) ? state.iot.logs : [];
        const match = arr.find(x => String(x.rx || '') === String(r.mac_address));
        return match ? Number(match.timestamp || 0) || null : null;
      })();
      const last = lastEvent != null ? lastEvent : lastSeen;
      const connected = last != null && (now - last) <= thresholdMs;
      return { mac_address: r.mac_address, name: r.name, last_seen: last, connected };
    });
    recs.sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0));
    return recs;
  }
}

