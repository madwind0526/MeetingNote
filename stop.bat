@echo off
setlocal enabledelayedexpansion
echo Stopping MeetingNote...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5185" ^| findstr "LISTENING"') do (
    echo Stopping server on port 5185 ^(PID %%P^)...
    taskkill /F /PID %%P >nul 2>&1
)

rem Only closes the MeetingNote window, not other unrelated Electron apps that may be
rem running (Electron dev processes all share the image name "electron.exe").
taskkill /F /IM electron.exe /FI "WINDOWTITLE eq MeetingNote*" >nul 2>&1

echo Done.
