#!/bin/sh
# 猫抓 (cat-catch) 本地 API 宿主 安装脚本 (macOS / Linux)
#
# 用法:
#   ./install.sh                 安装
#   ./install.sh --uninstall     卸载
#   ./install.sh --id=<扩展ID>   追加指定扩展 ID (可选)
#
# 安装后会:
#   1. 复制宿主程序到 ~/.cat-catch/
#   2. 为检测到的浏览器写入 Native Messaging 宿主清单
# 浏览器通过清单在需要时自动拉起宿主, 监听 127.0.0.1:23789 并提供 HTTP 接口。
#
# 注意: 脚本中所有目录列表都按换行分隔, 避免路径中的空格被拆分。

set -eu

HOST_NAME="com.cat_catch.api"
EXT_ID="goalojkljpmbbpnjbpkjgohlhdoidenp"
FIREFOX_EXT_ID="xifangczy@gmail.com"
INSTALL_DIR="$HOME/.cat-catch"

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 扩展根目录 (native-host 的上一级), 用于匹配浏览器中已加载的扩展路径
EXT_DIR=$(CDPATH= cd -- "$SRC_DIR/.." && pwd)

UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --id=*) EXT_ID="${arg#--id=}" ;;
    -h|--help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

##################### 浏览器配置目录 #####################

if [ "$(uname -s)" = "Darwin" ]; then
  CHROME_ROOTS="$HOME/Library/Application Support/Google/Chrome
$HOME/Library/Application Support/Chromium
$HOME/Library/Application Support/Microsoft Edge
$HOME/Library/Application Support/BraveSoftware/Brave-Browser
$HOME/Library/Application Support/Vivaldi"
  FIREFOX_DIRS="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
else
  CHROME_ROOTS="$HOME/.config/google-chrome
$HOME/.config/chromium
$HOME/.config/microsoft-edge
$HOME/.config/BraveSoftware/Brave-Browser
$HOME/.config/vivaldi"
  FIREFOX_DIRS="$HOME/.mozilla/native-messaging-hosts"
fi

# 每个浏览器根目录下的 NativeMessagingHosts 目录, 换行分隔
OLD_IFS=$IFS
IFS='
'
CHROME_DIRS=""
for root in $CHROME_ROOTS; do
  CHROME_DIRS="${CHROME_DIRS}${root}/NativeMessagingHosts
"
done
IFS=$OLD_IFS
CHROME_DIRS=${CHROME_DIRS%?}

# 从浏览器配置中探测已加载的扩展 ID (已安装过的扩展 ID 由路径决定, 与 key 无关)
detect_extension_ids() {
  CATCATCH_CHROME_ROOTS="$CHROME_ROOTS" CATCATCH_EXT_DIR="$EXT_DIR" node -e '
const fs = require("fs"), path = require("path");
let target;
try { target = fs.realpathSync(process.env.CATCATCH_EXT_DIR); } catch (e) { target = process.env.CATCATCH_EXT_DIR; }
const ids = new Set();
for (const root of (process.env.CATCATCH_CHROME_ROOTS || "").split("\n")) {
  if (!root) continue;
  let entries;
  try { entries = fs.readdirSync(root); } catch (e) { continue; }
  for (const dir of entries) {
    if (dir !== "Default" && !dir.startsWith("Profile ")) continue;
    for (const file of ["Preferences", "Secure Preferences"]) {
      let json;
      try { json = JSON.parse(fs.readFileSync(path.join(root, dir, file), "utf8")); } catch (e) { continue; }
      const settings = json?.extensions?.settings ?? {};
      for (const [id, value] of Object.entries(settings)) {
        if (!value?.path) continue;
        let real;
        try { real = fs.realpathSync(value.path); } catch (e) { continue; }
        if (real === target) ids.add(id);
      }
    }
  }
}
console.log([...ids].join("\n"));
'
}

# JSON 字符串转义
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

##################### 卸载 #####################

if [ "$UNINSTALL" = "1" ]; then
  printf '%s\n%s\n' "$CHROME_DIRS" "$FIREFOX_DIRS" | while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    rm -f "$dir/$HOST_NAME.json"
  done
  rm -rf "$INSTALL_DIR"
  echo "已卸载: 宿主文件和浏览器清单已删除"
  exit 0
fi

##################### 安装 #####################

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "错误: 未找到 node, 请先安装 Node.js (https://nodejs.org) 后重试" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$SRC_DIR/cat-catch-api.js" "$INSTALL_DIR/cat-catch-api.js"

# GUI 启动的浏览器 PATH 有限, 使用绝对 node 路径包装
cat > "$INSTALL_DIR/cat-catch-api" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$INSTALL_DIR/cat-catch-api.js" "\$@"
EOF
chmod +x "$INSTALL_DIR/cat-catch-api"
chmod +x "$INSTALL_DIR/cat-catch-api.js"

# 复制 cat-catch-server, 宿主收到扩展 init 消息时会自动拉起 (默认 7777)
SERVER_SRC="$SRC_DIR/../tools/server"
if [ -f "$SERVER_SRC/index.js" ]; then
  rm -rf "$INSTALL_DIR/server"
  mkdir -p "$INSTALL_DIR/server"
  cp "$SERVER_SRC/index.js" "$INSTALL_DIR/server/"
  cp -R "$SERVER_SRC/lib" "$INSTALL_DIR/server/"
  cp "$SERVER_SRC/package.json" "$INSTALL_DIR/server/"
  if [ -f "$SERVER_SRC/package-lock.json" ]; then
    cp "$SERVER_SRC/package-lock.json" "$INSTALL_DIR/server/"
  fi
  NPM_BIN=$(command -v npm || true)
  if [ -z "$NPM_BIN" ] && [ -x "$(dirname "$NODE_BIN")/npm" ]; then
    NPM_BIN="$(dirname "$NODE_BIN")/npm"
  fi
  if [ -n "$NPM_BIN" ]; then
    if (cd "$INSTALL_DIR/server" && "$NPM_BIN" install --omit=dev --no-audit --no-fund >/dev/null 2>&1); then
      echo "cat-catch-server 已安装: $INSTALL_DIR/server"
    else
      echo "警告: cat-catch-server 依赖安装失败, 请手动执行: cd $INSTALL_DIR/server && npm install" >&2
    fi
  else
    echo "警告: 未找到 npm, 请手动执行: cd $INSTALL_DIR/server && npm install" >&2
  fi
else
  echo "警告: 未找到 $SERVER_SRC, 跳过 cat-catch-server 安装" >&2
fi

HOST_PATH=$(json_escape "$INSTALL_DIR/cat-catch-api")

# 允许的扩展 ID: 固定的 key 派生 ID + 浏览器中已加载的路径 ID
ORIGINS=""
add_origin() {
  [ -z "$1" ] && return
  case "$ORIGINS" in
    *"chrome-extension://$1/"*) return ;;
  esac
  if [ -z "$ORIGINS" ]; then
    ORIGINS="    \"chrome-extension://$1/\""
  else
    ORIGINS="$ORIGINS,
    \"chrome-extension://$1/\""
  fi
}
add_origin "$EXT_ID"
DETECTED_IDS=$(detect_extension_ids || true)
while IFS= read -r id; do
  [ -z "$id" ] && continue
  add_origin "$id"
done <<EOF
$DETECTED_IDS
EOF
if [ -n "$(printf '%s' "$DETECTED_IDS" | tr -d '[:space:]')" ]; then
  echo "检测到浏览器中已加载的扩展 ID: $(printf '%s' "$DETECTED_IDS" | tr '\n' ' ')"
fi

COUNT=0
while IFS= read -r dir; do
  [ -z "$dir" ] && continue
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "cat-catch local HTTP api host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
$ORIGINS
  ]
}
EOF
  COUNT=$((COUNT + 1))
done <<EOF
$CHROME_DIRS
EOF

while IFS= read -r dir; do
  [ -z "$dir" ] && continue
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "cat-catch local HTTP api host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_extensions": [
    "$FIREFOX_EXT_ID"
  ]
}
EOF
  COUNT=$((COUNT + 1))
done <<EOF
$FIREFOX_DIRS
EOF

echo "安装完成"
echo "  宿主程序: $INSTALL_DIR/cat-catch-api"
echo "  cat-catch-server: $INSTALL_DIR/server"
echo "  Node.js : $NODE_BIN"
echo "  清单数量: $COUNT (每个浏览器配置目录一个)"
echo "  扩展 ID : $EXT_ID"
echo ""
echo "接下来:"
echo "  1. 在浏览器中重新加载扩展 (chrome://extensions)"
echo "  2. 扩展会自动拉起宿主 (127.0.0.1:23789) 并拉起 cat-catch-server (127.0.0.1:7777)"
echo "  3. 测试: curl 'http://127.0.0.1:23789/api/videos?url=https%3A%2F%2Fexample.com'"
echo "        curl 'http://127.0.0.1:7777/health'"
