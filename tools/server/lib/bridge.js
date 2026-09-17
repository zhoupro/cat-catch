"use strict";

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

/**
 * Bridge between the Node HTTP API and one or more Cat-Catch extension
 * instances. Extensions connect via WebSocket; the server dispatches
 * `catch` requests to a connected client and awaits the result.
 *
 * Wire protocol (all messages are JSON):
 *   ext  -> server: { type: "register", extId, version }
 *   server-> ext : { type: "registered", clientId }
 *   server-> ext : { type: "ping" }  (heartbeat)
 *   ext  -> server: { type: "pong" }
 *   server-> ext : { type: "catch", taskId, url, timeout, idle }
 *   ext  -> server: { type: "catch.result", taskId, list, pageTitle }
 *   ext  -> server: { type: "catch.error", taskId, error }
 */
class Bridge {
    constructor({ heartbeatMs = 25000, taskTimeoutMs = 90000 } = {}) {
        this.heartbeatMs = heartbeatMs;
        this.taskTimeoutMs = taskTimeoutMs;
        /** @type {Map<string, {ws:any, extId:string, version:string, alive:boolean, lastSeen:number}>} */
        this.clients = new Map();
        /** @type {Map<string, {resolve:Function, reject:Function, timer:any, extClientId:string}>} */
        this.pending = new Map();
        this.wss = null;
    }

    attach(server) {
        this.wss = new WebSocketServer({ server, path: "/ws" });
        this.wss.on("connection", (ws) => this._onConnection(ws));
        return this.wss;
    }

    _onConnection(ws) {
        const clientId = crypto.randomUUID();
        const entry = { ws, extId: null, version: null, alive: true, lastSeen: Date.now(), clientId };
        ws.on("message", (raw) => this._onMessage(entry, raw));
        ws.on("pong", () => { entry.alive = true; entry.lastSeen = Date.now(); });
        ws.on("close", () => this._dropClient(entry));
        ws.on("error", () => this._dropClient(entry));

        this.clients.set(clientId, entry);

        // Send a ping immediately; the extension must reply with a register
        // message before the server considers it usable. Heartbeat ticks
        // start once we know its extId.
        try { ws.send(JSON.stringify({ type: "hello", clientId, heartbeatMs: this.heartbeatMs })); } catch (_) { /* ignore */ }
    }

    _dropClient(entry) {
        if (!this.clients.has(entry.clientId)) return;
        this.clients.delete(entry.clientId);
        for (const [taskId, p] of this.pending) {
            if (p.extClientId === entry.clientId) {
                clearTimeout(p.timer);
                this.pending.delete(taskId);
                p.reject(new Error("扩展连接已断开"));
            }
        }
    }

    _onMessage(entry, raw) {
        entry.lastSeen = Date.now();
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        if (!msg || typeof msg !== "object") return;

        switch (msg.type) {
            case "register":
                entry.extId = msg.extId || null;
                entry.version = msg.version || null;
                entry.tag = msg.tag || null;
                entry.alive = true;
                this._send(entry, { type: "registered", clientId: entry.clientId });
                this._startHeartbeat(entry);
                return;
            case "pong":
                entry.alive = true;
                return;
            case "catch.result":
            case "catch.error": {
                const task = this.pending.get(msg.taskId);
                if (!task) return;
                this.pending.delete(msg.taskId);
                clearTimeout(task.timer);
                if (msg.type === "catch.error") {
                    task.reject(new Error(msg.error || "扩展返回错误"));
                } else {
                    task.resolve(msg);
                }
                return;
            }
            default:
                return;
        }
    }

    _startHeartbeat(entry) {
        if (entry._heartbeat) return;
        entry._heartbeat = setInterval(() => {
            if (!entry.alive) {
                try { entry.ws.terminate(); } catch (_) { /* ignore */ }
                this._dropClient(entry);
                return;
            }
            entry.alive = false;
            try { entry.ws.ping(); } catch (_) { /* ignore */ }
        }, this.heartbeatMs);
    }

    _send(entry, msg) {
        if (entry.ws.readyState !== 1) return;
        try { entry.ws.send(JSON.stringify(msg)); } catch (_) { /* ignore */ }
    }

    /**
     * Pick any live, registered client. Prefers the most recently seen one.
     */
    _pickClient() {
        let best = null;
        for (const c of this.clients.values()) {
            if (!c.extId) continue;
            if (!best || c.lastSeen > best.lastSeen) best = c;
        }
        return best;
    }

    /**
     * Send a catch task to a connected extension and await the result.
     * @param {string} url
     * @param {{timeout?:number, idle?:number, debug?:boolean}} [opts]
     */
    async catch(url, opts = {}) {
        const client = this._pickClient();
        if (!client) {
            throw new Error("没有可用的扩展连接，请确认 Cat-Catch 扩展已安装并启用，且浏览器保持打开");
        }

        const taskId = crypto.randomUUID();
        const timeout = Math.max(2000, Number(opts.timeout || 60000));
        const idle = Math.max(0, Number(opts.idle || 4000));
        const debug = !!opts.debug;

        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(taskId)) {
                    this.pending.delete(taskId);
                    reject(new Error(`扩展未在 ${timeout + idle + 5000}ms 内返回结果`));
                }
            }, timeout + idle + 5000);

            this.pending.set(taskId, {
                resolve: (msg) => resolve({
                    list: msg.list || [],
                    pageTitle: msg.pageTitle || "",
                    debug: msg.debug,
                }),
                reject,
                timer,
                extClientId: client.clientId,
            });
            this._send(client, { type: "catch", taskId, url, timeout, idle, debug });
        });
    }

    status() {
        const list = [];
        for (const c of this.clients.values()) {
            list.push({ clientId: c.clientId, extId: c.extId, version: c.version, tag: c.tag, lastSeen: c.lastSeen });
        }
        return {
            clients: list.length,
            registered: list.filter((c) => c.extId).length,
            pending: this.pending.size,
            list,
        };
    }
}

module.exports = { Bridge };