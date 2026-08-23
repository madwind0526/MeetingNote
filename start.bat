@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem No longer force-kills whatever's on port 5185 first: start-app.mjs now reuses an already
rem running Vite dev server instead of restarting it (Vite pays a large one-time module-transform
rem cost on its first request after starting, so restarting it every launch was the main reason
rem app startup felt slow) and guards against a duplicate launch itself via a PID lock file. Run
rem stop.bat if you actually want to shut everything down.
echo Starting MeetingNote...
call npm start
