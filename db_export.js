const crypto = require('crypto');
function pad(n) { return n.toString().padStart(2, '0'); }
function toMySQLDatetime(iso) {
  const d = iso ? new Date(iso) : new Date();
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const MM = pad(d.getMinutes());
  const SS = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

function escapeStr(s) {
  if (s == null) return 'NULL';
  return '\'' + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + '\'';
}

function hashFor(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function exportMySQLSQL(state, options = {}) {
  const dbName = options.database || 'dash_db';
  const engine = options.engine || 'InnoDB';
  const charset = options.charset || 'utf8mb4';

  const lines = state.list || [];
  const map = state.lines || {};
  const meta = state.meta || {};

  let sql = '';
  sql += `CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET ${charset};\n`;
  sql += `USE \`${dbName}\`;\n`;
 
  sql += `DROP TABLE IF EXISTS machines;\n`;
  sql += `DROP TABLE IF EXISTS lines;\n`;
  sql += `CREATE TABLE lines (\n`;
  sql += `  id VARCHAR(64) PRIMARY KEY,\n`;
  sql += `  style VARCHAR(64),\n`;
  sql += `  status VARCHAR(16) NOT NULL DEFAULT 'active'\n`;
  sql += `) ENGINE=${engine} DEFAULT CHARSET=${charset};\n`;
 
  sql += `CREATE TABLE machines (\n`;
  sql += `  id VARCHAR(64) PRIMARY KEY,\n`;
  sql += `  line_id VARCHAR(64) NOT NULL,\n`;
  sql += `  job VARCHAR(128) NOT NULL,\n`;
  sql += `  status VARCHAR(16) NOT NULL,\n`;
  sql += `  good INT NOT NULL DEFAULT 0,\n`;
  sql += `  reject INT NOT NULL DEFAULT 0,\n`;
  sql += `  updated_at DATETIME NOT NULL,\n`;
  sql += `  INDEX idx_line_id (line_id),\n`;
  sql += `  CONSTRAINT fk_line FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE CASCADE ON UPDATE CASCADE\n`;
  sql += `) ENGINE=${engine} DEFAULT CHARSET=${charset};\n`;
 

  if (lines.length) {
    sql += `INSERT INTO lines (id, style, status) VALUES\n`;
    sql += lines.map((l, i) => {
      const st = meta[l] && meta[l].style ? meta[l].style : null;
      const ls = meta[l] && meta[l].status ? meta[l].status : 'active';
      return `(${escapeStr(l)}, ${escapeStr(st)}, ${escapeStr(ls)})`;
    }).join(',\n');
    sql += `;\n`;
  }

  const machineRows = [];
  for (const l of lines) {
    const arr = map[l] || [];
    for (const m of arr) {
      machineRows.push(`(${escapeStr(m.machine)}, ${escapeStr(l)}, ${escapeStr(m.job)}, ${escapeStr(m.status)}, ${m.good || 0}, ${m.reject || 0}, ${escapeStr(toMySQLDatetime(m.updatedAt))})`);
    }
  }
  if (machineRows.length) {
    sql += `INSERT INTO machines (id, line_id, job, status, good, reject, updated_at) VALUES\n`;
    sql += machineRows.join(',\n');
    sql += `;\n`;
  }

  return sql;
}

module.exports = { exportMySQLSQL };
