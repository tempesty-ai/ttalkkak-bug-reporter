@echo off
title Ttalkkak AI Server
echo ==============================================
echo   Ttalkkak Bug Reporter - Ollama AI Server
echo ==============================================
echo.
echo [1/3] Stopping existing Ollama processes...
taskkill /F /IM "ollama app.exe" >nul 2>&1
taskkill /F /IM ollama.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] Starting server (extension access allowed)...
set "OLLAMA_ORIGINS=*"
set "OLLAMA_HOST=127.0.0.1:11434"
start "" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
timeout /t 5 /nobreak >nul

echo [3/3] Checking server status...
curl -s http://127.0.0.1:11434 >nul 2>&1
if %errorlevel%==0 (
  echo.
  echo   [ OK ] Server running: http://127.0.0.1:11434
  echo   Chrome extension AI is ready to use.
) else (
  echo.
  echo   [ !! ] No response yet. Wait a few seconds and run again.
)
echo.
echo   You can close this window - the server keeps running.
echo.
pause
