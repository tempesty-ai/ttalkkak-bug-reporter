@echo off
chcp 65001 >nul
title 딸깍 OpenAI 프록시
cd /d "%~dp0"

if not exist "config.local.json" (
  echo [안내] config.local.json 이 없습니다.
  echo        config.example.json 을 복사해서 config.local.json 으로 만들고
  echo        openaiKey / accessToken 을 채운 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

node openai-proxy.mjs
echo.
echo (프록시가 종료되었습니다. 창을 닫아도 됩니다.)
pause
