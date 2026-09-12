// Shared eSSL database access, used by both the one-shot CSV sync and the
// connector service. Everything about the schema is configurable because
// eTimeTrackLite has shipped more than one.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function loadConfig(env) {
    env = env || process.env;
    return {
        host: env.ESSL_DB_HOST || '127.0.0.1',
        port: Number(env.ESSL_DB_PORT || 3306),
        user: env.ESSL_DB_USER || 'root',
        password: env.ESSL_DB_PASSWORD || '',
        database: env.ESSL_DB_NAME || 'etimetracklite',
        table: env.ESSL_TABLE || 'DeviceLogs',
        colId: env.ESSL_COL_ID || 'DeviceLogId',
        colUser: env.ESSL_COL_USER || 'UserId',
        colStamp: env.ESSL_COL_STAMP || 'LogDate',
        colDirection: env.ESSL_COL_DIRECTION || 'Direction',
        colDevice: env.ESSL_COL_DEVICE || 'DeviceId',
        batch: Number(env.ESSL_BATCH || 50000),
        outDir: env.ESSL_OUT_DIR || path.join(__dirname, 'out'),
        port_http: Number(env.ESSL_SERVICE_PORT || 8710),
        token: env.ESSL_SERVICE_TOKEN || '',
        origin: env.ESSL_ALLOW_ORIGIN || '*'
    };
}

function connect(cfg) {
    return mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user,
        password: cfg.password, database: cfg.database
    });
}

const WATERMARK = path.join(__dirname, '.watermark');
function readWatermark() {
    try { return Number(fs.readFileSync(WATERMARK, 'utf8').trim()) || 0; } catch { return 0; }
}
function writeWatermark(v) {
    try { fs.writeFileSync(WATERMARK, String(v), 'utf8'); } catch { /* read-only disk: the caller still got its rows */ }
}

// Always hand out timestamps year-first, so nothing downstream has to guess
// whether 01/02 is January or February.
function fmtStamp(d) {
    if (!(d instanceof Date)) return String(d == null ? '' : d);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

async function probe(conn, cfg) {
    const [tables] = await conn.query('SHOW TABLES');
    const names = tables.map(r => Object.values(r)[0]);
    const hit = names.find(n => n.toLowerCase() === cfg.table.toLowerCase());
    const out = { database: cfg.database, tables: names, table: hit || null, columns: [], rowCount: null, missing: [] };
    if (!hit) return out;
    const [cols] = await conn.query('DESCRIBE `' + hit + '`');
    out.columns = cols.map(c => ({ name: c.Field, type: c.Type }));
    const have = out.columns.map(c => c.name.toLowerCase());
    [['ESSL_COL_ID', cfg.colId], ['ESSL_COL_USER', cfg.colUser], ['ESSL_COL_STAMP', cfg.colStamp],
     ['ESSL_COL_DIRECTION', cfg.colDirection], ['ESSL_COL_DEVICE', cfg.colDevice]].forEach(([env, col]) => {
        if (!have.includes(String(col).toLowerCase())) out.missing.push({ setting: env, value: col });
    });
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM `' + hit + '`');
    out.rowCount = n;
    return out;
}

// Either everything past a watermark, or a date range. The date range ignores
// the watermark on purpose, so a period can be pulled again after a correction
// — re-importing is safe because the punch log is de-duplicated on the way in.
async function fetchPunches(conn, cfg, opts) {
    opts = opts || {};
    const limit = Math.min(Number(opts.limit) || cfg.batch, 200000);
    const cols = '`' + cfg.colId + '` AS log_id, `' + cfg.colUser + '` AS device_user_id, ' +
                 '`' + cfg.colStamp + '` AS punch_at, `' + cfg.colDirection + '` AS direction, ' +
                 '`' + cfg.colDevice + '` AS device_id';
    let sql, params;
    if (opts.from && opts.to) {
        sql = 'SELECT ' + cols + ' FROM `' + cfg.table + '` WHERE `' + cfg.colStamp + '` >= ? AND `' +
              cfg.colStamp + '` < DATE_ADD(?, INTERVAL 1 DAY) ORDER BY `' + cfg.colId + '` LIMIT ?';
        params = [opts.from, opts.to, limit];
    } else {
        const since = opts.since === undefined || opts.since === null ? readWatermark() : Number(opts.since) || 0;
        sql = 'SELECT ' + cols + ' FROM `' + cfg.table + '` WHERE `' + cfg.colId + '` > ? ORDER BY `' +
              cfg.colId + '` LIMIT ?';
        params = [since, limit];
    }
    const [rows] = await conn.query(sql, params);
    return rows.map(r => ({
        logId: r.log_id,
        userId: r.device_user_id == null ? '' : String(r.device_user_id),
        punchAt: fmtStamp(r.punch_at),
        direction: r.direction == null ? '' : String(r.direction),
        deviceId: r.device_id == null ? '' : String(r.device_id)
    }));
}

function explain(err) {
    if (!err) return '';
    if (err.code === 'ER_NO_SUCH_TABLE') return 'That table is not in this database — run a probe to see what is.';
    if (err.code === 'ER_BAD_FIELD_ERROR') return 'One of the configured columns does not exist — run a probe to see the real names.';
    if (err.code === 'ECONNREFUSED') return 'Nothing is listening there — check the host and port, and that MySQL accepts this machine.';
    if (err.code === 'ER_ACCESS_DENIED_ERROR') return 'Wrong user or password, or that user has no rights on this database.';
    if (err.code === 'ETIMEDOUT') return 'The database did not answer in time — check the network route and any firewall.';
    return err.message;
}

module.exports = { loadConfig, connect, probe, fetchPunches, readWatermark, writeWatermark, fmtStamp, explain };
