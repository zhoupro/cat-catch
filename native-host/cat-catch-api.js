#!/usr/bin/env node
/**
 * 猫抓 (cat-catch) 本地 API 宿主程序
 *
 * 作用:
 *   Chrome MV3 扩展无法监听 TCP 端口, 由本程序通过 Native Messaging 被扩展拉起,
 *   在 127.0.0.1 上监听端口并提供 HTTP 接口, 接口请求转发给扩展执行网页探测。
 *   同时收到扩展 init 消息时自动拉起 cat-catch-server (tools/server, 默认 7777),
 *   用户不需要手动 npm start。
 *
 * 接口:
 *   GET  /api/videos?url=<网页地址>[&timeout=15000][&includeHeaders=true][&closeTab=true][&active=false]
 *   POST /api/videos   body: {"url":"...","timeout":15000,...}
 *   GET  /health
 *   GET  /
 *
 * 注意:
 *   - 本程序由 Chrome/Edge 自动启动, 不需要手动运行。
 *   - stdout 被 Native Messaging 协议占用, 调试信息只能输出到 stderr。
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST_VERSION = '1.0.0';
const DEFAULT_PORT = 23789;
const DEFAULT_TIMEOUT = 15000;
const MAX_TIMEOUT = 120000;
const MAX_CONCURRENT = 5;
const MAX_BODY_SIZE = 64 * 1024;

// cat-catch-server (tools/server) 的默认监听端口, 与 js/ws-client.js 的 WS_URL 一致
const CAT_SERVER_PORT = Number(process.env.CAT_CATCH_SERVER_PORT) || 7777;
const CAT_SERVER_CHECK_MS = 60 * 1000;

const state = {
    port: DEFAULT_PORT,
    token: '',
    server: null,
    inited: false,
    seq: 0,
    pending: new Map(),
    lastError: null,
    catServer: {
        spawning: false,
        lastTry: 0,
        missingLogged: false,
        lastError: null,
    },
};

function log(...args) {
    process.stderr.write(`[cat-catch-api ${new Date().toISOString()}] ${args.join(' ')}\n`);
}

////////////////////// cat-catch-server 自动拉起 //////////////////////

/**
 * 定位 cat-catch-server 入口 (tools/server/index.js)。安装后的布局为
 * <安装目录>/server/index.js; 直接从仓库运行宿主时用 ../tools/server。
 */
function findCatServerEntry() {
    const candidates = [
        process.env.CAT_CATCH_SERVER_ENTRY,
        path.join(__dirname, 'server', 'index.js'),
        path.resolve(__dirname, '..', 'tools', 'server', 'index.js'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) { return candidate; }
        } catch (e) { /* ignore */ }
    }
    return null;
}

function isPortOpen(port, timeout = 400) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const finish = (open) => { socket.destroy(); resolve(open); };
        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

/**
 * 确保 cat-catch-server 在 127.0.0.1:CAT_SERVER_PORT 上运行。
 * 扩展连上宿主 (init 消息) 时触发; 端口已在监听则什么都不做。
 * 服务以 detached 方式启动, 宿主退出后仍然存活。
 */
async function ensureCatServer() {
    const cat = state.catServer;
    if (cat.spawning) { return; }
    if (Date.now() - cat.lastTry < 5000) { return; }
    cat.lastTry = Date.now();
    if (await isPortOpen(CAT_SERVER_PORT)) { return; }
    const entry = findCatServerEntry();
    if (!entry) {
        if (!cat.missingLogged) {
            cat.missingLogged = true;
            log('cat-catch-server not found, skip auto start (run native-host/install.sh or set CAT_CATCH_SERVER_ENTRY)');
        }
        return;
    }
    cat.spawning = true;
    try {
        const child = spawn(process.execPath, [entry], {
            cwd: path.dirname(entry),
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, HOST: '127.0.0.1', PORT: String(CAT_SERVER_PORT) },
        });
        child.on('error', (e) => { cat.lastError = e.message; log('cat-catch-server spawn error', e.message); });
        child.unref();
        log(`cat-catch-server auto-started (pid ${child.pid}) http://127.0.0.1:${CAT_SERVER_PORT}`);
    } catch (e) {
        cat.lastError = e.message;
        log('cat-catch-server spawn failed', e.message);
    } finally {
        cat.spawning = false;
    }
}

setInterval(() => { ensureCatServer().catch(() => { /* ignore */ }); }, CAT_SERVER_CHECK_MS).unref();

////////////////////// Native Messaging //////////////////////

let readBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);
    while (readBuffer.length >= 4) {
        const length = readBuffer.readUInt32LE(0);
        if (length > 64 * 1024 * 1024) {
            log('invalid message length', length);
            process.exit(1);
        }
        if (readBuffer.length < 4 + length) { break; }
        const raw = readBuffer.subarray(4, 4 + length).toString('utf8');
        readBuffer = readBuffer.subarray(4 + length);
        let message;
        try {
            message = JSON.parse(raw);
        } catch (e) {
            log('JSON parse error', e.message);
            continue;
        }
        handleMessage(message);
    }
});

process.stdin.on('end', () => shutdown('stdin end'));
process.stdin.on('error', () => shutdown('stdin error'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { log('uncaughtException', e.stack ?? e.message); shutdown('uncaught'); });

function sendToExtension(message) {
    try {
        const json = Buffer.from(JSON.stringify(message), 'utf8');
        const header = Buffer.alloc(4);
        header.writeUInt32LE(json.length, 0);
        process.stdout.write(Buffer.concat([header, json]));
    } catch (e) {
        log('sendToExtension error', e.message);
    }
}

function handleMessage(message) {
    if (!message || typeof message !== 'object') { return; }
    if (message.type === 'init') {
        state.inited = true;
        const port = Number.parseInt(message.port, 10);
        state.port = (!Number.isFinite(port) || port < 1 || port > 65535) ? DEFAULT_PORT : port;
        state.token = typeof message.token === 'string' ? message.token : '';
        startServer();
        ensureCatServer().catch(() => { /* ignore */ });
        return;
    }
    if (message.type === 'ping') {
        sendToExtension({ type: 'pong', time: Date.now() });
        ensureCatServer().catch(() => { /* ignore */ });
        return;
    }
    if (message.type === 'result') {
        const item = state.pending.get(message.id);
        if (!item) { return; }
        state.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.ok) { item.resolve(message.data); } else { item.reject(message.error); }
        return;
    }
}

function askExtension(payload, timeout) {
    return new Promise((resolve, reject) => {
        if (!state.inited) {
            reject(makeError('NO_EXTENSION', 'extension is not connected'));
            return;
        }
        if (state.pending.size >= MAX_CONCURRENT) {
            reject(makeError('BUSY', 'too many concurrent requests'));
            return;
        }
        const id = ++state.seq;
        const timer = setTimeout(() => {
            state.pending.delete(id);
            reject(makeError('TIMEOUT', 'extension did not respond in time'));
        }, timeout);
        state.pending.set(id, { resolve, reject, timer });
        sendToExtension({ type: 'probe', id, ...payload });
    });
}

////////////////////// HTTP Server //////////////////////

function makeError(code, message) {
    return { code, message };
}

function startServer() {
    stopServer();
    const server = http.createServer(handleRequest);
    server.on('error', (e) => {
        state.lastError = e.code ?? e.message;
        log('http server error', state.lastError);
        sendToExtension({ type: 'hostStatus', ok: false, port: state.port, error: state.lastError });
    });
    server.listen(state.port, '127.0.0.1', () => {
        state.server = server;
        state.lastError = null;
        log(`http server listening on 127.0.0.1:${state.port}`);
        sendToExtension({ type: 'hostStatus', ok: true, port: state.port, version: HOST_VERSION });
    });
}

function stopServer() {
    if (state.server) {
        try { state.server.close(); } catch (e) { /* ignore */ }
        try { state.server.closeAllConnections?.(); } catch (e) { /* ignore */ }
        state.server = null;
    }
}

function shutdown(reason) {
    log('shutdown:', reason);
    stopServer();
    for (const item of state.pending.values()) {
        clearTimeout(item.timer);
        item.reject(makeError('HOST_CLOSED', 'native host closed'));
    }
    state.pending.clear();
    process.exit(0);
}

function sendJson(res, status, body) {
    const data = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
    });
    res.end(data);
}

function checkToken(req, url) {
    if (!state.token) { return true; }
    const header = req.headers['x-api-token'];
    const query = url.searchParams.get('token');
    return header === state.token || query === state.token;
}

function parseBool(value) {
    if (value === undefined || value === null || value === '') { return null; }
    if (typeof value === 'boolean') { return value; }
    return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function handleRequest(req, res) {
    // 不返回 CORS 头, 避免任意网页读取接口内容
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Allow': 'GET, POST, OPTIONS' });
        res.end();
        return;
    }
    let url;
    try {
        url = new URL(req.url, `http://127.0.0.1:${state.port}`);
    } catch (e) {
        sendJson(res, 400, { ok: false, error: makeError('BAD_REQUEST', 'invalid request url') });
        return;
    }
    if (!checkToken(req, url)) {
        sendJson(res, 401, { ok: false, error: makeError('UNAUTHORIZED', 'invalid or missing token') });
        return;
    }
    if (url.pathname === '/' && req.method === 'GET') {
        sendJson(res, 200, {
            ok: true,
            name: 'cat-catch-api',
            version: HOST_VERSION,
            port: state.port,
            endpoints: {
                'GET /api/videos': 'query: url(必填), timeout(ms), includeHeaders, closeTab, active',
                'POST /api/videos': 'json: {"url":"...","timeout":15000,"includeHeaders":true,"closeTab":true,"active":false}',
                'GET /health': '宿主与扩展连接状态',
            },
        });
        return;
    }
    if (url.pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
            ok: true,
            extension: state.inited,
            port: state.port,
            pending: state.pending.size,
            lastError: state.lastError,
        });
        return;
    }
    if (url.pathname === '/api/videos' && req.method === 'GET') {
        handleProbe(res, {
            url: url.searchParams.get('url'),
            timeout: url.searchParams.get('timeout'),
            includeHeaders: parseBool(url.searchParams.get('includeHeaders')),
            closeTab: parseBool(url.searchParams.get('closeTab')),
            active: parseBool(url.searchParams.get('active')),
        });
        return;
    }
    if (url.pathname === '/api/videos' && req.method === 'POST') {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                sendJson(res, 413, { ok: false, error: makeError('BODY_TOO_LARGE', 'request body too large') });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (res.writableEnded) { return; }
            let body = {};
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (text) {
                try {
                    body = JSON.parse(text);
                } catch (e) {
                    sendJson(res, 400, { ok: false, error: makeError('BAD_JSON', 'request body is not valid json') });
                    return;
                }
            }
            handleProbe(res, {
                url: body.url,
                timeout: body.timeout,
                includeHeaders: parseBool(body.includeHeaders),
                closeTab: parseBool(body.closeTab),
                active: parseBool(body.active),
            });
        });
        return;
    }
    sendJson(res, 404, { ok: false, error: makeError('NOT_FOUND', 'unknown endpoint') });
}

async function handleProbe(res, params) {
    const url = typeof params.url === 'string' ? params.url.trim() : '';
    if (!url) {
        sendJson(res, 400, { ok: false, error: makeError('INVALID_URL', 'url is required') });
        return;
    }
    if (!/^https?:\/\//i.test(url)) {
        sendJson(res, 400, { ok: false, error: makeError('INVALID_URL', 'only http/https url is supported') });
        return;
    }
    let timeout = Number.parseInt(params.timeout, 10);
    if (!Number.isFinite(timeout)) { timeout = DEFAULT_TIMEOUT; }
    timeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT);

    const payload = { url, timeout };
    if (params.includeHeaders !== null) { payload.includeHeaders = params.includeHeaders; }
    if (params.closeTab !== null) { payload.closeTab = params.closeTab; }
    if (params.active !== null) { payload.active = params.active; }

    try {
        const data = await askExtension(payload, timeout + 30000);
        sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
        const code = e?.code ?? 'EXTENSION_ERROR';
        const status = code === 'TIMEOUT' ? 504 : code === 'NO_EXTENSION' ? 503 : code === 'BUSY' ? 429 : 502;
        sendJson(res, status, { ok: false, error: makeError(code, e?.message ?? String(e)) });
    }
}
