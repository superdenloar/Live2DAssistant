@echo off
title Live2D Assistant Launcher

echo =======================================================
echo     Live2D Assistant Launcher
echo =======================================================
echo.

cd /d "%~dp0"

if exist venv\Scripts\activate (
    echo [+] Activating virtual environment (venv)...
    call venv\Scripts\activate
)

echo [+] Starting the Python server on http://127.0.0.1:5000...
echo     (To stop the server, press Ctrl+C in this window)
echo.

start "" "http://127.0.0.1:5000"
python -m uvicorn python_server:api --host 127.0.0.1 --port 5000

echo.
echo =======================================================
echo The application has stopped.
echo Press any key to close this window.
echo =======================================================
pause
