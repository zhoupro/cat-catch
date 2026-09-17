# cat-catch-server

独立 Node.js 服务，与 Cat-Catch 浏览器扩展配合工作，**不需要 CDP**——直接复用用户已打开的 Chrome 浏览器。

## 架构

```
┌─────────────┐   HTTP POST /api/catch    ┌──────────────────┐
│  任意调用方  │ ─────────────────────────▶ │  cat-catch-server │
└─────────────┘                            │   (Node.js)       │
                                           │   ws://:7777/ws   │
                                           └────────┬─────────┘
                                                    │ WebSocket
                                                    ▼
                                           ┌──────────────────┐
                                           │  Cat-Catch 扩展    │ (用户已打开的 Chrome)
                                           │  js/ws-client.js   │
                                           └──────────────────┘
```

- 扩展 `service worker` 启动后主动连接 `ws://127.0.0.1:7777/ws`，注册自身。
- 客户端调用 `POST /api/catch {url}`，服务把任务分发给一个在线扩展。
- 扩展后台打开标签访问 URL，等页面加载完成 + 注入 `catch-script/search.js` 触发深度搜索，然后从扩展的 `cacheData` 取回视频资源返回。

## 安装扩展

按根目录 `README.md` 的方式安装 Cat-Catch 扩展（应用商店或源码加载）。**不需要**额外的 Chrome 配置——用户用什么浏览器、什么 user-data-dir 都行，服务复用浏览器已有的 cookie / 登录态。

## 启动服务

```bash
cd tools/server
npm install
npm start
```

输出：

```
[cat-catch-server] listening on http://127.0.0.1:7777
[cat-catch-server] ws endpoint: ws://127.0.0.1:7777/ws
[cat-catch-server] usage: curl -X POST http://127.0.0.1:7777/api/catch -H 'content-type: application/json' -d '{"url":"https://example.com"}'
```

启动后扩展会自动连接（首次加载扩展或 service worker 被唤醒时触发）。

## 接口

### `GET /health`

```bash
curl http://127.0.0.1:7777/health
```

```json
{ "ok": true, "clients": 1, "registered": 1, "pending": 0 }
```

- `clients`：当前 WebSocket 连接数
- `registered`：已完成 register 消息的扩展数（业务可用数）
- `pending`：正在处理的探测任务数

### `POST /api/catch`

入参（JSON）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | 要探测的网页 URL，必须 `http(s)://` 开头 |
| `timeout` | number(ms) | 60000 | 等待页面 load 完成的最长时间 |
| `idle` | number(ms) | 4000 | load 后继续等待多久收集延迟资源 |

返回：

```json
{
  "ok": true,
  "url": "https://www.example.com/video",
  "count": 2,
  "list": [
    {
      "url": "https://cdn.example.com/720p.m3u8",
      "name": "720p.m3u8",
      "ext": "m3u8",
      "type": "application/vnd.apple.mpegurl",
      "size": 1234,
      "tabId": 12,
      "title": "...",
      "webUrl": "...",
      "getTime": 1737100000000
    }
  ],
  "pageTitle": "...",
  "elapsedMs": 4321
}
```

失败时返回 HTTP 504：

```json
{
  "ok": false,
  "error": "没有可用的扩展连接，请确认 Cat-Catch 扩展已安装并启用，且浏览器保持打开",
  "url": "..."
}
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 7777 | HTTP / WS 监听端口 |
| `HOST` | 127.0.0.1 | 监听地址（仅本机，避免外部访问） |

`js/ws-client.js` 内的 `WS_URL` 默认 `ws://127.0.0.1:7777/ws`，可修改。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `tools/server/index.js` | HTTP + WebSocket 服务入口 |
| `tools/server/lib/bridge.js` | 扩展↔服务桥接逻辑（注册、任务分发、超时） |
| `js/ws-client.js` | 扩展侧 WS 客户端（保持连接、调度 catch 任务、读 cacheData） |
| `js/background.js` | `importScripts("/js/ws-client.js")` 启动客户端 |

## 排错

1. `/health` 中 `registered: 0`：
   - 检查浏览器是否已加载扩展（`chrome://extensions`）
   - 浏览器是否打开（SW 被休眠后无法连，等用户操作唤醒）
   - 端口是否被防火墙拦截
2. `/api/catch` 返回 "没有可用的扩展连接"：同 1；扩展未完成 register（`hello` 后未发 `register`）也算未注册。
3. 抓不到视频：检查浏览器是否登录目标站点，扩展默认会自动捕获，但部分站点对未登录只返回试看段。`timeout`/`idle` 调大可以让深度搜索跑更久。
4. MV3 service worker 5 分钟会被休眠：通过 `chrome.alarms` 每 0.4 分钟 keepalive，唤醒后会自动重连。

## 不依赖 CDP 的好处

- **复用用户 cookie / 登录态**：直接打开网页拿到登录后内容。
- **零浏览器配置**：用户原有的 Chrome 不需要加 `--remote-debugging-port`。
- **真·Cat-Catch 能力**：扩展的 webRequest、深度搜索、正则匹配、cookie 提取全部生效，返回结构和扩展弹窗里看到的项一致。