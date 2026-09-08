@echo off
chcp 65001 >nul
title ttalkkak OpenAI proxy
cd /d "%~dp0"
if not exist "config.local.json" goto NOCONFIG
echo Starting ttalkkak OpenAI proxy...
node openai-proxy.mjs
echo.
echo (proxy stopped - you can close this window)
pause
goto END
:NOCONFIG
echo [!] config.local.json not found.
echo     Copy config.example.json to config.local.json and fill openaiKey / accessToken.
pause
:END
