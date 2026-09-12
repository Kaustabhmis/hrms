#!/usr/bin/env node
/**
 * eSSL connector service
 *
 * A browser cannot open a MySQL connection, so this small read-only service
 * sits next to the eSSL database and hands punches to the HRMS over HTTP. Run
 * it on the machine with eTimeTrackLite on it (or anything that can reach that
 * MySQL), point the HRMS at it, and the eSSL Device Import screen can pull
 * straight from the database instead of passing a file around by hand.
 *
 *   GET /health                        is it up, and can it see the database
 *   GET /probe                         tables, columns, row count
 *   GET /punches?since=<logId>         everything newer than that log id
 *   GET /punches?from=&to=             a date range (ignores the watermark)
 *   POST /watermark {logId}            record how far the HRMS has taken
 *
 * It is read-only against MySQL: every query is a SELECT, and the database user
 * only needs SELECT. Keep it on the LAN — it holds database credentials and is
 * not meant to face the internet. Set ESSL_SERVICE_TOKEN and the HRMS must send
 * it before anything answers.
 */
const http = require('http');
const path = require('path');
const { URL } = require('url');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const lib = require('./lib');

const cfg = lib.loadConfig();

function send(res, status, body, origin) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        // A page opened straight from a file has the origin "null", which is
        // why this is permissive by default; narrow it with ESSL_ALLOW_ORIGIN.
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type, X-ESSL-Token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Cache-Control': 'no-store'
    });
    res.end(payload);
}
function authorised(req) {
    if (!cfg.token) return true;
    const header = req.headers['x-essl-token'];
    return header && String(header) === cfg.token;
}

async function withDb(fn) {
    const conn = await lib.connect(cfg);
    try { return await fn(conn); } finally { await conn.end(); }
}

const server = http.createServer(async (req, res) => {
    const origin = cfg.origin === '*' ? (req.headers.origin || '*') : cfg.origin;
    if (req.method === 'OPTIONS') return send(res, 204, {}, origin);

    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'Bad URL' }, origin); }
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (!authorised(req)) return send(res, 401, { error: 'Bad or missing token.' }, origin);

    try {
        if (route === '/health') {
            const info = await withDb(async conn => {
                const [[row]] = await conn.query('SELECT 1 AS ok');
                return row.ok === 1;
            });
            return send(res, 200, {
                service: 'essl-connector', version: 1, ok: info,
                database: cfg.database, table: cfg.table,
                watermark: lib.readWatermark(), tokenRequired: !!cfg.token
            }, origin);
        }
        if (route === '/probe') {
            const out = await withDb(conn => lib.probe(conn, cfg));
            return send(res, 200, out, origin);
        }
        if (route === '/punches') {
            const q = url.searchParams;
            const opts = {
                since: q.get('since'),
                from: q.get('from') || '',
                to: q.get('to') || '',
                limit: q.get('limit')
            };
            if ((opts.from && !opts.to) || (opts.to && !opts.from))
                return send(res, 400, { error: 'A date range needs both from and to.' }, origin);
            const rows = await withDb(conn => lib.fetchPunches(conn, cfg, opts));
            const highest = rows.reduce((a, r) => (Number(r.logId) > a ? Number(r.logId) : a), 0);
            return send(res, 200, {
                count: rows.length,
                highestLogId: highest || null,
                watermark: lib.readWatermark(),
                mode: opts.from ? 'range' : 'incremental',
                truncated: rows.length >= Math.min(Number(opts.limit) || cfg.batch, 200000),
                punches: rows
            }, origin);
        }
        if (route === '/watermark' && req.method === 'POST') {
            let body = '';
            req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
            await new Promise(r => req.on('end', r));
            let logId = 0;
            try { logId = Number(JSON.parse(body || '{}').logId) || 0; } catch { /* fall through to the 400 */ }
            if (!logId) return send(res, 400, { error: 'Send {"logId": <number>}.' }, origin);
            lib.writeWatermark(logId);
            return send(res, 200, { watermark: lib.readWatermark() }, origin);
        }
        return send(res, 404, { error: 'No such endpoint. Try /health, /probe or /punches.' }, origin);
    } catch (err) {
        return send(res, 500, { error: err.message, hint: lib.explain(err), code: err.code || '' }, origin);
    }
});

server.listen(cfg.port_http, () => {
    console.log(`eSSL connector listening on http://localhost:${cfg.port_http}`);
    console.log(`  database : ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
    console.log(`  table    : ${cfg.table}`);
    console.log(`  token    : ${cfg.token ? 'required' : 'NOT SET — anyone who can reach this port can read punches'}`);
    console.log(`\nIn HRMS: eSSL Device Import → Direct database connection → http://localhost:${cfg.port_http}`);
});
