@echo off
rem 猫抓本地 API 宿主的 Windows 启动包装脚本 (Native Messaging 不支持直接执行 .js)
setlocal
set "NODE=node"
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
"%NODE%" "%~dp0cat-catch-api.js" %*
