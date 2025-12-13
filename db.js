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
  const port = Number(process.env.DB_PORT || 3306);
  let user = process.env.DB_USER || '';
  let password = process.env.DB_PASS || '';
  let dbName = process.env.BUTTON_DB_NAME || 'button_db';
  let cred = { user, password };
  const candidates = [
    { user, password },
    { user: 'root', password: '' },
    { user: 'root', password: 'root' },
    { user: 'mysql', password: '' },
    { user: 'admin', password: '' }
  ];
  let connected = false;
  for (const c of candidates) {
    try {
      const conn = await mysql.createConnection({ host, user: c.user, password: c.password, port });
      if (!process.env.BUTTON_DB_NAME) {
        const foundMaster = await discoverMasterDataSchema({ host, user: c.user, password: c.password, port });
        const foundUser = await discoverMasterUsersSchema({ host, user: c.user, password: c.password, port });
        const chosen = foundMaster || foundUser;
        if (chosen) dbName = chosen;
      }
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      await conn.end();
      cred = c;
      connected = true;
      break;
    } catch {}
  }
  if (!connected) { BUTTON_DB_READY = false; return; }
  poolButton = await mysql.createPool({
    host,
    user: cred.user,
    password: cred.password,
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
      'CREATE TABLE IF NOT EXISTS jenis_mesin (\n' +
      '  id_jnsmesin INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  name VARCHAR(128)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS merk_mesin (\n' +
      '  id_merk INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  name VARCHAR(128),\n' +
      '  id_jnsmesin INT NULL,\n' +
      '  CONSTRAINT fk_mm_jenis FOREIGN KEY (id_jnsmesin) REFERENCES jenis_mesin(id_jnsmesin)\n' +
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
  try {
    await poolButton.execute(
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
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS style_proses (\n' +
      '  id_proses INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  id_style INT,\n' +
      '  nama_proses VARCHAR(128)\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try {
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS master_mesin (\n' +
      '  id_mesin INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  id_merk INT NULL,\n' +
      '  id_jnsmesin INT NULL,\n' +
      '  id_kategori INT NULL\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  } catch {}
  try { await poolButton.execute('ALTER TABLE style_order MODIFY id_jenis_pakaian INT NULL DEFAULT NULL'); } catch {}
  try {
    await poolButton.execute(
      'CREATE TABLE IF NOT EXISTS proses_produksi (\n' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,\n' +
      '  nama VARCHAR(128) UNIQUE\n' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    const [cnt] = await poolButton.query('SELECT COUNT(*) AS c FROM proses_produksi');
    const c = (Array.isArray(cnt) && cnt[0] && (cnt[0].c || cnt[0].C)) ? Number(cnt[0].c || cnt[0].C) : 0;
    if (!c) {
      const list = [
        'Fusing','Jahit kupnat','Jahit lipit','Jahit Saku Patch','Jahit Saku Welt','Jahit Saku Kangaroo','Jahit Saku Samping','Jahit Saku Belakang','Jahit Plaket','Jahit Panel Badan','Sambung Bahu','Jahit Sisi Badan','Jahit Pesak','Pasang Lengan','Jahit Kerah','Jahit Tudung','Pasang Manset','Pasang Rib Leher','Pasang Rib Lengan','Pasang Rib Bawah','Pasang Ban Pinggang','Pasang Elastik / Drawstring','Pasang Resleting','Pasang Lining','Satukan Shell & Lining','Jahit Ban Bawah','Kelim Lengan','Kelim Badan','Kelim Kaki','Overdeck','Overstitch','Topstitch','Bartack Penguat','Jahit Lubang Kancing','Pasang Kancing','Pasang Eyelet','Press'
      ];
      for (const nm of list) { try { await poolButton.execute('INSERT IGNORE INTO proses_produksi (nama) VALUES (?)', [nm]); } catch {} }
    }
  } catch {}
  try {
    const poolConn = poolButton;
    const existsKategori = await tableExists(poolConn, 'kategori');
    if (existsKategori) await dropTableWithFk(poolConn, 'kategori');
    const existsSpm = await tableExists(poolConn, 'style_proses_mesin');
    if (existsSpm) await dropTableWithFk(poolConn, 'style_proses_mesin');
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
      const [r1] = await poolButton.query('SELECT id_line FROM master_lines WHERE nama_line = ? LIMIT 1', [name]);
      const lineId = Array.isArray(r1) && r1[0] ? r1[0].id_line : null;
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
  return state.lines[line] || [];
}

async function getLineStyleLive(line) {
  try {
    await ensureButtonMasterSchema();
    const [r1] = await poolButton.query('SELECT id_line FROM master_lines WHERE nama_line = ? LIMIT 1', [line]);
    const lineId = Array.isArray(r1) && r1[0] ? r1[0].id_line : null;
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

async function getMasterLine() {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) {
    return (state.list || []).map((n, i) => ({ id_line: i + 1, nama_line: n }));
  }
  try {
    const [rows] = await poolButton.query('SELECT id_line, nama_line FROM master_lines');
    return rows.map(r => ({ id_line: r.id_line, nama_line: r.nama_line }));
  } catch {}
  return [];
}

async function resolveLineIdByName(name) {
  await ensureButtonMasterSchema();
  const q = String(name || '').trim();
  if (!q) return null;
  try {
    const [r1] = await poolButton.query('SELECT id_line FROM master_lines WHERE nama_line = ? LIMIT 1', [q]);
    if (Array.isArray(r1) && r1.length) return r1[0].id_line;
  } catch {}
  try {
    const [r3] = await poolButton.query('SELECT id_line FROM master_lines WHERE UPPER(nama_line) = UPPER(?) LIMIT 1', [q]);
    if (Array.isArray(r3) && r3.length) return r3[0].id_line;
  } catch {}
  try {
    const [r4] = await poolButton.query('SELECT id_line FROM master_lines WHERE REPLACE(UPPER(nama_line), " ", "") = REPLACE(UPPER(?), " ", "") LIMIT 1', [q]);
    if (Array.isArray(r4) && r4.length) return r4[0].id_line;
  } catch {}
  return null;
}

async function createMasterLine({ nama_line }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { id_line: Date.now(), nama_line };
  let res;
  try {
    [res] = await poolButton.execute('INSERT INTO master_lines (nama_line) VALUES (?)', [nama_line]);
  } catch {}
  return { id_line: res.insertId, nama_line };
}

async function updateMasterLine(id, { nama_line }) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  try {
    await poolButton.execute('UPDATE master_lines SET nama_line = ? WHERE id_line = ?', [nama_line, id]);
  } catch {}
  return { ok: true };
}

async function deleteMasterLine(id) {
  await ensureButtonMasterSchema();
  if (!BUTTON_DB_READY) return { ok: true };
  try {
    await poolButton.execute('DELETE FROM master_lines WHERE id_line = ?', [id]);
  } catch {}
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
  const arr = state.lines[line] || [];
  const jobs = tasksForStyle(style);
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    arr[i] = { ...m, job: jobs[i % jobs.length], updatedAt: new Date().toISOString() };
  }
  state.lines[line] = arr;
  try {
    const processes = jobs.map(n => ({ name: n }));
    saveStyleOrder({ line, category: '', type: style, processes }).catch(() => {});
  } catch {}
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
          const [ex] = await poolConn.query('SELECT id_line FROM master_lines WHERE nama_line = ? LIMIT 1', [name]);
          if (!(Array.isArray(ex) && ex.length)) {
            await poolConn.execute('INSERT INTO master_lines (nama_line) VALUES (?)', [name]);
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
    // Merge master_line into master_lines if exists, then drop duplicate
    if (await tableExists(poolConn, 'master_line')) {
      const [rows] = await poolConn.query('SELECT nama_line FROM master_line');
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!r.nama_line) continue;
        try {
          const [ex] = await poolConn.query('SELECT id_line FROM master_lines WHERE nama_line = ? LIMIT 1', [r.nama_line]);
          if (!(Array.isArray(ex) && ex.length)) {
            await poolConn.execute('INSERT INTO master_lines (nama_line) VALUES (?)', [r.nama_line]);
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

module.exports = { seedInitial, getState, getLines, getLine, getLineStyle, setLineStyle, setLineStatus, upsertMachine, incrementMachine, getStateLive, getLinesLive, getLineLive, getLineStyleLive, getLineStatusLive, 
  initMySQL, getMySQLPool,
  initButtonDB, ensureButtonSchema, getButtonPool: () => poolButton,
  ensurePrimarySchema,
  refreshLinesFromMaster,
  getJenisMesinMaster, createJenisMesinMaster, updateJenisMesinMaster, deleteJenisMesinMaster,
  getMerkMaster, createMerkMaster, updateMerkMaster, deleteMerkMaster,
  getProsesProduksi,
  getMasterLine, createMasterLine, updateMasterLine, deleteMasterLine,
  saveStyleOrder, getStyleOrderByLine, addStyleProcess, deleteStyleProcess, renameStyleProcess, addProcessMachines, getMasterOrderSummary,
  deleteProcessMachines, deleteMasterOrderForLine,
  migrateLegacyTables,
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
      okWrite = true;
    } catch {}
  }
  try {
    await ensureButtonMasterSchema();
    let lineId = null;
    lineId = await resolveLineIdByName(line);
    try {
      const now = toSqlDatetime(new Date().toISOString());
      if (lineId != null) {
        const [ins] = await poolButton.execute(
          'INSERT INTO master_styles (id_line, category, style_nama, created_at) VALUES (?, ?, ?, ?)',
          [lineId, category || '', type || '', now]
        );
        if (ins && ins.insertId) okWrite = true;
        const [cur] = await poolButton.query('SELECT id_style FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [lineId]);
        const styleId = Array.isArray(cur) && cur[0] ? cur[0].id_style : null;
        if (styleId != null && Array.isArray(processes)) {
          for (let i = 0; i < processes.length; i++) {
            const nm = String(processes[i].name || '').trim();
            if (!nm) continue;
            try {
              const [p1] = await poolButton.query('SELECT id_proses FROM style_proses WHERE id_style = ? AND nama_proses = ? LIMIT 1', [styleId, nm]);
              if (!(Array.isArray(p1) && p1.length)) {
                await poolButton.execute('INSERT INTO style_proses (id_style, nama_proses) VALUES (?, ?)', [styleId, nm]);
              }
            } catch {}
          }
        }
      } else {
        // Jika line belum ada di master_lines, tambahkan lalu simpan master_styles
        try {
          const [insLine] = await poolButton.execute('INSERT INTO master_lines (nama_line) VALUES (?)', [String(line || '').trim()]);
          const newId = insLine && insLine.insertId ? insLine.insertId : null;
          if (newId != null) {
            await poolButton.execute('INSERT INTO master_styles (id_line, category, style_nama, created_at) VALUES (?, ?, ?, ?)', [newId, category || '', type || '', now]);
            const [cur2] = await poolButton.query('SELECT id_style FROM master_styles WHERE id_line = ? ORDER BY id_style DESC LIMIT 1', [newId]);
            const styleId2 = Array.isArray(cur2) && cur2[0] ? cur2[0].id_style : null;
            if (styleId2 != null && Array.isArray(processes)) {
              for (let i = 0; i < processes.length; i++) {
                const nm = String(processes[i].name || '').trim();
                if (!nm) continue;
                try { await poolButton.execute('INSERT INTO style_proses (id_style, nama_proses) VALUES (?, ?)', [styleId2, nm]); } catch {}
              }
            }
            okWrite = true;
          }
        } catch {}
      }
    } catch (e) { console.error('style_order_write_error', { message: String(e && e.message || e) }); }
  } catch {}
  state.meta = state.meta || {};
  const cur = state.meta[line] || { status: 'active' };
  state.meta[line] = { style: type || null, status: cur.status || 'active', processes: (Array.isArray(processes) ? processes.map(p => ({ name: String(p.name || '') })) : []) };
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
      const [insLine] = await poolButton.execute('INSERT INTO master_lines (nama_line) VALUES (?)', [String(line || '').trim()]);
      lineId = insLine && insLine.insertId ? insLine.insertId : null;
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
        upsertMachine({ line, machine: m.machine, job: nmNew, good: m.good, reject: m.reject, status: m.status });
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

async function addProcessMachines({ line, processName, machineType, qty }) {
  const count = Math.max(1, Number(qty) || 1);
  const arr = getLine(line) || [];
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
    upsertMachine({ line, machine: id, job: processName || 'Unknown', good: 0, reject: 0, status: 'active' });
    created++;
  }
  state.meta = state.meta || {};
  const cur = state.meta[line] || { style: null, status: 'active' };
  const defs = cur.defaults || {};
  defs[processName] = { type: String(machineType || ''), qty: Number(count) };
  state.meta[line] = { style: cur.style || null, status: cur.status || 'active', processes: cur.processes || [], defaults: defs };
  save()
  try { await upsertMasterOrderForLine(line); } catch {}
  return { ok: true };
}

async function deleteProcessMachines({ line, processName, machineType }) {
  const arr = getLine(line) || [];
  const prefix = `${line}-${processName}-${machineType}-`;
  const out = arr.filter(m => !(String(m.machine).startsWith(prefix) && String(m.job) === String(processName)));
  state.lines[line] = out;
  state.meta = state.meta || {};
  const cur = state.meta[line] || { style: null, status: 'active' };
  const defs = cur.defaults || {};
  if (defs[processName] && String(defs[processName].type) === String(machineType)) {
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
    const [r1] = await poolConn.query('SELECT id_line FROM master_lines WHERE nama_line = ? LIMIT 1', [line]);
    const lineId = Array.isArray(r1) && r1[0] ? r1[0].id_line : null;
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
    const [linesRows] = await poolButton.query('SELECT id_line, nama_line FROM master_lines ORDER BY id_line ASC');
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
