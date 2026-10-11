"use strict";

const http = require("http");
const express = require("express");
const { Bridge } = require("./lib/bridge");

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "127.0.0.1";

const bridge = new Bridge();
const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
    const s = bridge.status();
    res.json({
        ok: true,
        clients: s.clients,
        registered: s.registered,
        pending: s.pending,
        list: s.list,
    });
});

/**
 * POST /api/catch
 * body: { url, timeout?, idle? }
 *   timeout: navigation/wait timeout in ms (default 60000)
 *   idle:    extra wait after load for late resources (default 4000)
 * returns: { ok, url, count, list, pageTitle, elapsedMs }
 */
app.post("/api/catch", async (req, res) => {
    const body = req.body || {};
    const url = (body.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "缺少 url 参数" });
    if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ ok: false, error: "url 必须以 http:// 或 https:// 开头" });
    }

    const started = Date.now();
    try {
        const { list, pageTitle, debug } = await bridge.catch(url, {
            timeout: body.timeout,
            idle: body.idle,
            debug: body.debug,
        });
        const out = {
            ok: true,
            url,
            count: list.length,
            list,
            pageTitle,
            elapsedMs: Date.now() - started,
        };
        if (debug) out.debug = debug;
        res.json(out);
    } catch (e) {
        res.status(504).json({
            ok: false,
            error: e.message || String(e),
            url,
            elapsedMs: Date.now() - started,
        });
    }
});

app.use((err, _req, res, _next) => {
    res.status(500).json({ ok: false, error: err.message || String(err) });
});

/**
 * POST /api/reload
 * Ask a connected extension to call chrome.runtime.reload() — handy after
 * editing extension code, so you don't have to click the reload button on
 * chrome://extensions. Local-only convenience for development.
 */
app.post("/api/reload", (_req, res) => {
    const s = bridge.status();
    if (!s.registered) {
        return res.status(503).json({ ok: false, error: "没有可用的扩展连接" });
    }
    bridge.broadcast({ type: "reload" });
    res.json({ ok: true, clients: s.registered });
});

const server = http.createServer(app);
bridge.attach(server);

server.listen(PORT, HOST, () => {
    console.log(`[cat-catch-server] listening on http://${HOST}:${PORT}`);
    console.log(`[cat-catch-server] ws endpoint: ws://${HOST}:${PORT}/ws`);
    console.log(`[cat-catch-server] usage: curl -X POST http://${HOST}:${PORT}/api/catch -H 'content-type: application/json' -d '{"url":"https://example.com"}'`);
});

function shutdown(signal) {
    console.log(`[cat-catch-server] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));