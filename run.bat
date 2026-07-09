@echo off
title Live2D Assistant Launcher

echo =======================================================
echo     Live2D Assistant Launcher
echo =======================================================
echo.

echo [+] Navigating to the script's directory...
cd /d "%~dp0"

echo [+] Activating virtual environment (venv)...
call venv\Scripts\activate

echo [+] Checking and installing required packages...
python -m pip install -r requirements.txt

echo.
echo [+] Starting the Python application...
echo     (To stop the server, press Ctrl+C in this window)
echo.

rem Запускаем Python-сервер в ЭТОМ ЖЕ ОКНЕ.
rem Теперь все логи и ошибки будут видны здесь.
python -m uvicorn python_server:api --host 127.0.0.1 --port 5000

echo.
echo =======================================================
echo The application has stopped.
echo Press any key to close this window.
echo =======================================================
pause