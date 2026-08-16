@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo Checking for an existing server on port 5185...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5185" ^| findstr "LISTENING"') do (
    echo Found existing server on port 5185 ^(PID %%P^) - stopping it...
    taskkill /F /PID %%P >nul 2>&1
)

echo Starting MeetingNote...
call npm start
