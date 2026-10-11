"use strict";
/**
 * Cat-Catch WebSocket 客户端（运行在扩展 service worker 内）。
 *
 * - 启动后连接到本地 cat-catch-server（默认 ws://127.0.0.1:7777/ws）。
 * - 收到 {type:"catch", taskId, url, timeout, idle} 时：
 *     1. 后台打开新标签访问 url
 *     2. 等页面 load 完成后注入 catch-script/search.js 触发深度搜索
 *     3. 等待 idle + 深度搜索回报
 *     4. 从 cacheData[tabId] 读取 Cat-Catch 已识别的视频资源并回传
 *     5. 关闭标签
 * - 通过 chrome.alarms 周期性 keepalive，避免 MV3 SW 被强制休眠。
 * - 连接断开时按指数退避重连。
 */

const WS_URL = "ws://127.0.0.1:7777/ws";
const HEARTBEAT_MS = 20000;
const MIN_RECONNECT = 1000;
const MAX_RECONNECT = 15000;
const KEEPALIVE_ALARM = "cat-catch-ws-keepalive";
const WS_CLIENT_TAG = "ws-client-v2-debug";

let ws = null;
let reconnectDelay = MIN_RECONNECT;
let reconnectTimer = null;
let heartbeatTimer = null;
let manuallyClosed = false;
let deepSearchBusy = new Set(); // tabId currently being captured

function send(msg) {
    if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
    }
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => send({ type: "pong" }), HEARTBEAT_MS);
}
function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function scheduleReconnect() {
    if (manuallyClosed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(MAX_RECONNECT, Math.floor(reconnectDelay * 1.6));
}

function connect() {
    if (manuallyClosed) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try {
        ws = new WebSocket(WS_URL);
    } catch (e) {
        scheduleReconnect();
        return;
    }
    ws.onopen = () => {
        reconnectDelay = MIN_RECONNECT;
        const manifest = chrome.runtime.getManifest();
        send({ type: "register", extId: chrome.runtime.id, version: manifest.version, tag: WS_CLIENT_TAG });
        startHeartbeat();
    };
    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        handleMessage(msg);
    };
    ws.onerror = () => { /* close handler will trigger reconnect */ };
    ws.onclose = () => {
        stopHeartbeat();
        ws = null;
        scheduleReconnect();
    };
}

async function handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
        case "hello":
        case "registered":
            return;
        case "ping":
            send({ type: "pong" });
            return;
        case "catch":
            catchTask(msg).catch((e) => console.error("[ws-client] catchTask error", e));
            return;
        case "reload":
            // 允许本机 cat-catch-server 远程触发扩展重载（改完扩展代码后
            // 免去手动点 chrome://extensions 的刷新按钮）。
            chrome.runtime.reload();
            return;
    }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getTabInfo(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return resolve(null);
            resolve(tab);
        });
    });
}

/**
 * Scan the page directly for <video>/<audio>/<source> media URLs. This is
 * Cat-Catch's fallback when webRequest misses something (e.g. blob: from
 * MSE, or extension-generated media).
 */
function scanPageMedia(tabId) {
    return new Promise((resolve) => {
        chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                const out = [];
                const seen = new Set();
                const push = (url, tag, srcAttr) => {
                    if (!url || seen.has(url)) return;
                    seen.add(url);
                    out.push({ url, tag, srcAttr });
                };
                const tags = ["video", "audio"];
                for (const tag of tags) {
                    document.querySelectorAll(tag).forEach((el) => {
                        if (el.currentSrc) push(el.currentSrc, tag, "currentSrc");
                        if (el.src && el.src !== el.currentSrc) push(el.src, tag, "src");
                        el.querySelectorAll("source").forEach((s) => {
                            if (s.src) push(s.src, tag, "source.src");
                        });
                        // MSE buffers?
                        try {
                            if (el.srcObject && el.srcObject.toString) {
                                push(el.srcObject.toString(), tag, "srcObject");
                            }
                        } catch (_) { /* ignore */ }
                    });
                }
                return out;
            },
            world: "MAIN",
        }, (results) => {
            if (chrome.runtime.lastError) return resolve([]);
            const list = [];
            for (const r of results || []) {
                if (r && Array.isArray(r.result)) list.push(...r.result);
            }
            resolve(list);
        });
    });
}

function waitForLoad(tabId, timeout) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (reason) => {
            if (done) return;
            done = true;
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve(reason);
        };
        const listener = (updatedId, info, tab) => {
            if (updatedId !== tabId) return;
            if (info.status === "complete") finish("complete");
        };
        const timer = setTimeout(() => finish("timeout"), Math.max(2000, timeout));
        chrome.tabs.onUpdated.addListener(listener);
    });
}

function createTab(url) {
    return new Promise((resolve, reject) => {
        // active:true 避免某些站点因 visibilityState=hidden 拒绝加载资源；
        // 探测结束后会立刻 removeTab，干扰很小。
        chrome.tabs.create({ url, active: true }, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                return reject(new Error(chrome.runtime.lastError?.message || "createTab 失败"));
            }
            resolve(tab);
        });
    });
}

function removeTab(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.remove(tabId, () => {
            chrome.runtime.lastError; // swallow
            resolve();
        });
    });
}

function injectScript(tabId, file, allFrames, world) {
    return new Promise((resolve) => {
        chrome.scripting.executeScript({
            target: { tabId, allFrames: !!allFrames },
            files: [file],
            injectImmediately: true,
            world: world || "MAIN",
        }, () => {
            chrome.runtime.lastError; // swallow
            resolve();
        });
    });
}

/**
 * Read the media items that Cat-Catch's background.js has already classified
 * for this tab.
 *
 * ws-client.js runs inside the same service worker as background.js, and
 * chrome.runtime.sendMessage() is never delivered back to the sender's own
 * frame (onMessage fires in every extension frame *except* the sender's), so
 * asking ourselves via runtime messaging would always resolve empty. Read the
 * shared `cacheData` global (declared in init.js, same SW scope) directly;
 * if the SW was just restarted and init.js hasn't restored it yet, fall back
 * to the persisted storage.session copy.
 */
async function readMediaForTab(tabId) {
    try {
        if (typeof cacheData !== "undefined" && Array.isArray(cacheData[tabId])) {
            return cacheData[tabId];
        }
    } catch (e) { /* ignore, fall through to storage */ }
    return new Promise((resolve) => {
        (chrome.storage.session ?? chrome.storage.local).get({ MediaData: {} }, (items) => {
            if (chrome.runtime.lastError) { return resolve([]); }
            const data = items?.MediaData ?? {};
            resolve(Array.isArray(data[tabId]) ? data[tabId] : []);
        });
    });
}

function normaliseItem(info) {
    if (!info || !info.url) return null;
    return {
        url: info.url,
        name: info.name || "",
        ext: info.ext,
        type: info.type || info.mime,
        size: info.size,
        tabId: info.tabId,
        requestId: info.requestId,
        initiator: info.initiator,
        webUrl: info.webUrl,
        title: info.title,
        getTime: info.getTime,
        // 部分 CDN(抖音等)要求带 Referer/Cookie 才放行,透传给服务端。
        requestHeaders: info.requestHeaders,
        cookie: info.cookie,
    };
}

async function catchTask(task) {
    const { taskId, url, timeout, idle, debug } = task;
    let tabId = null;
    try {
        const tab = await createTab(url);
        tabId = tab.id;

        const waitMs = Math.max(2000, Number(timeout || 60000));
        await waitForLoad(tabId, waitMs);

        const idleMs = Math.max(0, Number(idle || 4000));
        if (idleMs > 0) await sleep(idleMs);

        // 注入深度搜索脚本，触发 search.js 的 hook
        deepSearchBusy.add(tabId);
        try {
            const scriptCfg = (typeof G !== "undefined" && G.scriptList && G.scriptList.get("search.js")) || {};
            await injectScript(tabId, "catch-script/search.js", scriptCfg.allFrames !== false, scriptCfg.world || "MAIN");
            await sleep(Math.min(6000, idleMs + 2000));
        } catch (e) {
            // 注入失败不影响后续流程
        } finally {
            deepSearchBusy.delete(tabId);
        }

        // 主路径：Cat-Catch 已经在 cacheData 中识别的资源
        const raw = await readMediaForTab(tabId);

        // 兜底：直接扫页面 <video>/<audio> 元素的 src
        // 解决 MSE blob: URL、CDN 通过 fetch 拿不到 Referer 等场景
        let pageScans = [];
        try { pageScans = await scanPageMedia(tabId); } catch (_) { /* ignore */ }

        // 合并：cacheData 优先（已分类 ext/type/size），pageScan 补漏
        const urlMap = new Map();
        for (const item of raw.map(normaliseItem).filter(Boolean)) {
            urlMap.set(item.url, item);
        }
        for (const scan of pageScans) {
            if (urlMap.has(scan.url)) continue;
            const ext = (scan.url.match(/\.([a-z0-9]{2,5})(\?|$)/i) || [])[1];
            urlMap.set(scan.url, {
                url: scan.url,
                name: "",
                ext,
                type: undefined,
                size: undefined,
                tag: scan.tag,
                srcAttr: scan.srcAttr,
                fromPageScan: true,
                getTime: Date.now(),
            });
        }
        const list = Array.from(urlMap.values());

        const tabInfo = await getTabInfo(tabId);
        const resultMsg = {
            type: "catch.result",
            taskId,
            list,
            pageTitle: tabInfo?.title || "",
        };
        if (debug) resultMsg.debug = {
            tabCacheCount: raw.length,
            pageScanCount: pageScans.length,
            finalCount: list.length,
            enable: !!G.enable,
            damn: !!G.damn,
            initSync: !!G.initSyncComplete,
            initLocal: !!G.initLocalComplete,
            cacheKeys: Object.keys(cacheData).length,
        };
        send(resultMsg);
    } catch (e) {
        send({ type: "catch.error", taskId, error: e.message || String(e) });
    } finally {
        if (tabId !== null) await removeTab(tabId);
    }
}

/**
 * MV3 keepalive: alarms fire at least every 30s for active SWs. A 0.4-minute
 * alarm is the smallest period Chrome allows.
 */
function ensureKeepaliveAlarm() {
    chrome.alarms.get(KEEPALIVE_ALARM, (alarm) => {
        if (!alarm) {
            chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
        }
    });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    // 触一下，让 SW 保持唤醒；同时确保连接活着
    if (!ws || ws.readyState !== 1) {
        connect();
    } else {
        send({ type: "pong" });
    }
});

chrome.runtime.onStartup?.addListener(() => {
    ensureKeepaliveAlarm();
    connect();
});

chrome.runtime.onInstalled.addListener(() => {
    ensureKeepaliveAlarm();
    connect();
});

ensureKeepaliveAlarm();
connect();