#!/usr/bin/env node
/**
 * eSSL / eTimeTrackLite → BISCS HRMS punch feed
 *
 * Reads new rows out of the MySQL database eTimeTrackLite writes to and puts
 * them in a CSV that the HRMS "eSSL Device Import" screen reads directly.
 *
 * It is deliberately a feed rather than a push: until the HRMS has a backend of
 * its own there is nothing to POST to, and a CSV on disk is something you can
 * open and check before it touches payroll. When the backend exists, swap
 * writeCsv() for an HTTP call — nothing else here changes.
 *
 * The watermark (the highest log id already pulled) is kept in .watermark so
 * each punch is fetched exactly once, however often this runs.
 *
 * Usage:
 *   cp .env.example .env && edit it
 *   npm install
 *   node sync.js              # one pull
 *   node sync.js --full       # ignore the watermark and pull everything
 *   node sync.js --probe      # just show the tables/columns, write nothing
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const cfg = {
    host: process.env.ESSL_DB_HOST || '127.0.0.1',
    port: Number(process.env.ESSL_DB_PORT || 3306),
    user: process.env.ESSL_DB_USER || 'root',
    password: process.env.ESSL_DB_PASSWORD || '',
    database: process.env.ESSL_DB_NAME || 'etimetracklite',
    // eTimeTrackLite has shipped more than one schema, so every name is
    // configurable and --probe tells you which ones yours uses.
    table: process.env.ESSL_TABLE || 'DeviceLogs',
    colId: process.env.ESSL_COL_ID || 'DeviceLogId',
    colUser: process.env.ESSL_COL_USER || 'UserId',
    colStamp: process.env.ESSL_COL_STAMP || 'LogDate',
    colDirection: process.env.ESSL_COL_DIRECTION || 'Direction',
    colDevice: process.env.ESSL_COL_DEVICE || 'DeviceId',
    batch: Number(process.env.ESSL_BATCH || 50000),
    outDir: process.env.ESSL_OUT_DIR || path.join(__dirname, 'out')
};

const WATERMARK = path.join(__dirname, '.watermark');
const args = process.argv.slice(2);
const full = args.includes('--full');
const probe = args.includes('--probe');

function readWatermark() {
    if (full) return 0;
    try { return Number(fs.readFileSync(WATERMARK, 'utf8').trim()) || 0; } catch { return 0; }
}
function writeWatermark(v) { fs.writeFileSync(WATERMARK, String(v), 'utf8'); }

function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? fmtStamp(v) : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// Always write year-first, so the importer never has to guess day vs month.
function fmtStamp(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

async function probeSchema(conn) {
    const [tables] = await conn.query('SHOW TABLES');
    const names = tables.map(r => Object.values(r)[0]);
    console.log(`\nTables in ${cfg.database} (${names.length}):`);
    names.forEach(n => console.log('  ' + n + (n.toLowerCase() === cfg.table.toLowerCase() ? '   ← configured as the punch table' : '')));
    const hit = names.find(n => n.toLowerCase() === cfg.table.toLowerCase());
    if (!hit) {
        console.log(`\n"${cfg.table}" is not in this database. Set ESSL_TABLE to whichever of the above holds raw punches.`);
        return;
    }
    const [cols] = await conn.query(`DESCRIBE \`${hit}\``);
    console.log(`\nColumns in ${hit}:`);
    cols.forEach(c => console.log('  ' + c.Field.padEnd(24) + c.Type));
    const have = cols.map(c => c.Field.toLowerCase());
    [['ESSL_COL_ID', cfg.colId], ['ESSL_COL_USER', cfg.colUser], ['ESSL_COL_STAMP', cfg.colStamp],
     ['ESSL_COL_DIRECTION', cfg.colDirection], ['ESSL_COL_DEVICE', cfg.colDevice]].forEach(([env, col]) => {
        if (!have.includes(col.toLowerCase())) console.log(`\n  ⚠ ${env}="${col}" is not a column here — set it to the right one.`);
    });
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${hit}\``);
    console.log(`\n${n} row(s) in ${hit}.`);
}

async function main() {
    const conn = await mysql.createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user,
        password: cfg.password, database: cfg.database, dateStrings: false
    });
    try {
        if (probe) return await probeSchema(conn);

        const since = readWatermark();
        const sql =
            `SELECT \`${cfg.colId}\` AS log_id, \`${cfg.colUser}\` AS device_user_id, ` +
            `\`${cfg.colStamp}\` AS punch_at, \`${cfg.colDirection}\` AS direction, ` +
            `\`${cfg.colDevice}\` AS device_id ` +
            `FROM \`${cfg.table}\` WHERE \`${cfg.colId}\` > ? ORDER BY \`${cfg.colId}\` LIMIT ?`;
        const [rows] = await conn.query(sql, [since, cfg.batch]);

        if (!rows.length) {
            console.log(`No new punches since log id ${since}.`);
            return;
        }
        fs.mkdirSync(cfg.outDir, { recursive: true });
        const stamp = fmtStamp(new Date()).replace(/[: ]/g, '-');
        const file = path.join(cfg.outDir, `essl-punches-${stamp}.csv`);
        const header = ['UserId', 'LogDate', 'Direction', 'DeviceId'];
        const body = rows.map(r => [r.device_user_id, r.punch_at, r.direction, r.device_id].map(csvCell).join(','));
        fs.writeFileSync(file, '﻿' + [header.join(','), ...body].join('\r\n'), 'utf8');

        const highest = rows[rows.length - 1].log_id;
        writeWatermark(highest);

        const first = rows[0].punch_at, last = rows[rows.length - 1].punch_at;
        console.log(`${rows.length} punch(es), log id ${rows[0].log_id} → ${highest}`);
        console.log(`Covering ${first instanceof Date ? fmtStamp(first) : first} → ${last instanceof Date ? fmtStamp(last) : last}`);
        console.log(`Written to ${file}`);
        if (rows.length === cfg.batch) console.log('Batch was full — run again to fetch the rest.');
        console.log('\nNow open HRMS → eSSL Device Import and drop that file in.');
    } finally {
        await conn.end();
    }
}

main().catch(err => {
    console.error('\nSync failed:', err.message);
    if (err.code === 'ER_NO_SUCH_TABLE') console.error(`Run "node sync.js --probe" to see what tables this database actually has.`);
    if (err.code === 'ER_BAD_FIELD_ERROR') console.error(`Run "node sync.js --probe" to see the real column names, then set them in .env.`);
    if (err.code === 'ECONNREFUSED') console.error('Nothing is listening there — check ESSL_DB_HOST and ESSL_DB_PORT, and that MySQL allows this machine in.');
    if (err.code === 'ER_ACCESS_DENIED_ERROR') console.error('Wrong user or password, or that user has no rights on this database.');
    process.exit(1);
});
