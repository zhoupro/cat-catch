/**
 * 本地 HTTP API
 *
 * 浏览器扩展无法直接监听端口, 这里通过 Native Messaging 连接本地宿主程序
 * (native-host/cat-catch-api.js), 由宿主在 127.0.0.1 上提供 HTTP 接口,
 * 宿主把请求转发到这里执行网页探测, 把抓取到的媒体列表返回给调用方。
 *
 * 宿主程序需要先运行 native-host/install.sh (macOS/Linux) 或 install.ps1 (Windows) 安装。
 */
const API_HOST_NAME = "com.cat_catch.api";
const API_QUIET_MS = 1500;              // 页面加载完成后等待多久没有新媒体则认为抓取结束
const API_MAX_RESULT_BYTES = 900 * 1024; // Native Messaging 单条消息上限 1MB, 留出余量

let apiPort = null;
let apiRetryTimer = undefined;
let apiRetryCount = 0;
let apiConnecting = false;
const apiStatus = {
    connected: false,       // 与宿主进程通信正常
    inited: false,          // 宿主已收到配置并启动 HTTP 服务
    port: null,             // 实际监听端口
    hostVersion: null,
    error: null,            // 最近一次错误
    probes: 0,              // 已处理的探测请求数
    lastProbe: null,        // 最近一次探测摘要
};

function apiSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function apiError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function apiUpdateStatus(patch) {
    Object.assign(apiStatus, patch);
}

////////////////////// 宿主连接 //////////////////////

function apiConnect() {
    if (!G.apiEnable) { apiDisconnect(); return; }
    if (apiPort || apiConnecting) { return; }
    apiConnecting = true;
    clearTimeout(apiRetryTimer);
    let port = null;
    try {
        port = chrome.runtime.connectNative(API_HOST_NAME);
    } catch (e) {
        apiConnecting = false;
        apiUpdateStatus({ connected: false, inited: false, error: e.message });
        apiScheduleRetry();
        return;
    }
    apiConnecting = false;
    apiPort = port;
    port.onMessage.addListener(apiOnHostMessage);
    port.onDisconnect.addListener(function () {
        const lastError = chrome.runtime.lastError;
        apiPort = null;
        apiUpdateStatus({ connected: false, inited: false, error: lastError?.message ?? "native host disconnected" });
        apiScheduleRetry();
    });
    port.postMessage({
        type: "init",
        port: G.apiPort,
        token: G.apiToken || "",
        version: chrome.runtime.getManifest().version,
    });
    apiUpdateStatus({ connected: true, error: null });
    apiRetryCount = 0;
    chrome.alarms.clear("apiReconnect");
}

function apiDisconnect() {
    clearTimeout(apiRetryTimer);
    chrome.alarms.clear("apiReconnect");
    apiRetryCount = 0;
    if (apiPort) {
        try { apiPort.disconnect(); } catch (e) { /* ignore */ }
        apiPort = null;
    }
    apiUpdateStatus({ connected: false, inited: false });
}

function apiScheduleRetry() {
    if (!G.apiEnable) { return; }
    clearTimeout(apiRetryTimer);
    const delay = Math.min(1000 * Math.pow(2, apiRetryCount), 30000);
    apiRetryCount++;
    apiRetryTimer = setTimeout(apiConnect, delay);
    // Service Worker 休眠后 setTimeout 不保证执行, 用 alarm 兜底
    chrome.alarms.create("apiReconnect", { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === "apiReconnect") { apiConnect(); }
});

////////////////////// 宿主消息 //////////////////////

function apiOnHostMessage(message) {
    if (!message || typeof message !== "object") { return; }
    if (message.type === "probe") {
        apiHandleProbe(message);
        return;
    }
    if (message.type === "hostStatus") {
        apiUpdateStatus({
            inited: !!message.ok,
            port: message.port,
            hostVersion: message.version ?? apiStatus.hostVersion,
            error: message.ok ? null : (message.error ?? "listen failed"),
        });
        return;
    }
    if (message.type === "pong") { return; }
}

async function apiHandleProbe(message) {
    apiStatus.probes++;
    let data = null;
    let error = null;
    try {
        data = await apiProbe(message);
    } catch (e) {
        error = { code: e.code ?? "PROBE_FAILED", message: e.message ?? String(e) };
    }
    if (!apiPort) { return; }
    if (error) {
        apiStatus.lastProbe = { url: message.url, ok: false, error: error.code, time: Date.now() };
        apiPort.postMessage({ type: "result", id: message.id, ok: false, error });
        return;
    }
    apiStatus.lastProbe = { url: message.url, ok: true, count: data.count, elapsed: data.elapsed, time: Date.now() };
    apiPort.postMessage({ type: "result", id: message.id, ok: true, data: apiLimitResult(data) });
}

////////////////////// 探测逻辑 //////////////////////

function apiNormalizeUrl(input) {
    if (typeof input !== "string" || !input.trim()) {
        throw apiError("INVALID_URL", "url is required");
    }
    let url = input.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { url = "https://" + url; }
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        throw apiError("INVALID_URL", "invalid url: " + url);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw apiError("INVALID_URL", "only http/https url is supported");
    }
    return parsed.toString();
}

function apiFormatItem(item, includeHeaders) {
    const data = {
        requestId: item.requestId,
        url: item.url,
        name: item.name,
        ext: item.ext,
        type: item.type,
        size: item.size,
        title: item.title,
        webUrl: item.webUrl,
        initiator: item.initiator,
        getTime: item.getTime,
        isRegex: item.isRegex,
    };
    if (includeHeaders) {
        data.requestHeaders = item.requestHeaders ?? null;
        data.cookie = item.cookie ?? null;
    }
    return data;
}

/**
 * 后台打开网址 等待媒体抓取完成
 * @param {Object} options {url, timeout, closeTab, includeHeaders, active}
 */
async function apiProbe(options) {
    const url = apiNormalizeUrl(options.url);
    if (!G.enable) {
        throw apiError("DISABLED", "extension is disabled");
    }
    if (isDamnUrl(url)) {
        throw apiError("BLOCKED_URL", "this website is in the cat-catch opt-out list");
    }
    if (isLockUrl(url)) {
        throw apiError("BLOCKED_URL", "this website is in your block url list");
    }
    let timeout = parseInt(options.timeout);
    if (!Number.isFinite(timeout)) { timeout = parseInt(G.apiTimeout) || 15000; }
    timeout = Math.min(Math.max(timeout, 1000), 120000);
    const closeTab = options.closeTab ?? G.apiCloseTab ?? true;
    const includeHeaders = options.includeHeaders ?? G.apiIncludeHeaders ?? true;
    const active = options.active ?? false;
    const start = Date.now();

    let tab;
    try {
        tab = await chrome.tabs.create({ url, active });
    } catch (e) {
        throw apiError("TAB_CREATE_FAILED", e.message);
    }
    const tabId = tab.id;
    // 清掉可能残留的同 tabId 数据
    delete cacheData[tabId];
    G.urlMap.delete(tabId);

    let tabInfo = tab;
    let tabClosed = false;
    let timedOut = false;
    let lastCount = 0;
    let lastChange = start;

    while (true) {
        if (Date.now() - start >= timeout) { timedOut = true; break; }
        await apiSleep(250);
        const list = cacheData[tabId];
        if (list && list.length !== lastCount) {
            lastCount = list.length;
            lastChange = Date.now();
        }
        try {
            tabInfo = await chrome.tabs.get(tabId);
        } catch (e) {
            tabClosed = true;
            break;
        }
        // 页面加载完成且一段时间内没有新媒体, 认为抓取结束
        if (tabInfo.status === "complete" && lastCount > 0 && Date.now() - lastChange >= API_QUIET_MS) {
            break;
        }
    }

    const list = cacheData[tabId] ?? [];
    const videos = list.map(item => apiFormatItem(item, includeHeaders));
    const result = {
        url,
        finalUrl: tabInfo?.url ?? url,
        title: tabInfo?.title ?? null,
        elapsed: Date.now() - start,
        timedOut,
        tabClosed,
        count: videos.length,
        videos,
    };

    if (closeTab && !tabClosed) {
        try { await chrome.tabs.remove(tabId); } catch (e) { /* ignore */ }
    }
    if (closeTab && !tabClosed) {
        delete cacheData[tabId];
        G.urlMap.delete(tabId);
    }
    return result;
}

/**
 * Native Messaging 单条消息上限 1MB, 超出时先去掉请求头, 再截断列表
 */
function apiLimitResult(result) {
    if (JSON.stringify(result).length <= API_MAX_RESULT_BYTES) { return result; }
    const light = {
        ...result,
        headersOmitted: true,
        videos: result.videos.map(item => {
            const copy = { ...item };
            delete copy.requestHeaders;
            delete copy.cookie;
            return copy;
        }),
    };
    if (JSON.stringify(light).length <= API_MAX_RESULT_BYTES) { return light; }
    light.truncated = true;
    let videos = light.videos;
    while (videos.length > 1 && JSON.stringify(light).length > API_MAX_RESULT_BYTES) {
        videos = videos.slice(0, Math.floor(videos.length / 2));
        light.videos = videos;
        light.count = videos.length;
    }
    return light;
}

////////////////////// 初始化 //////////////////////

awaitG(function () {
    if (G.apiEnable) { apiConnect(); }
    chrome.storage.onChanged.addListener(function (changes) {
        if (changes.apiEnable) {
            G.apiEnable ? apiConnect() : apiDisconnect();
        }
        if (apiPort && (changes.apiPort || changes.apiToken)) {
            apiDisconnect();
            apiConnect();
        }
    });
}, 200);

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message?.Message === "apiStatus") {
        sendResponse({ ...apiStatus, enable: !!G.apiEnable, optionPort: G.apiPort });
        return true;
    }
    if (message?.Message === "apiRestart") {
        apiDisconnect();
        apiConnect();
        sendResponse("ok");
        return true;
    }
});
