@echo off
chcp 65001 >nul
title Шашки + Live2D Launcher

echo ═══════════════════════════════════════════════
echo     Шашки + Live2D Assistant Launcher
echo ═══════════════════════════════════════════════
echo.

cd /d "%~dp0"

echo [1/3] Запускаем основной сервер (порт 5000)...
start "Live2D Main Server" cmd /c "cd /d "%~dp0" && (if exist venv\Scripts\activate call venv\Scripts\activate) && python -m uvicorn python_server:api --host 127.0.0.1 --port 5000"

echo       Ждём запуска основного сервера...
timeout /t 3 /nobreak >nul

echo [2/3] Запускаем сервер шашек (порт 8080)...
start "Checkers Server" cmd /c "cd /d "%~dp0AnotherServer" && python server.py"

echo       Ждём запуска сервера шашек...
timeout /t 2 /nobreak >nul

echo.
echo [3/3] Открываем браузер...
start "" "http://127.0.0.1:8080"

echo.
echo ═══════════════════════════════════════════════
echo   Оба сервера запущены!
echo.
echo   Шашки:            http://127.0.0.1:8080
echo   Основной сервер:  http://127.0.0.1:5000
echo.
echo   Чтобы остановить всё, закройте окна серверов.
echo ═══════════════════════════════════════════════
echo.
pause
