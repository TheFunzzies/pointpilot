@echo off
cd /d "%~dp0"
if not exist node_modules goto run
:run
call npm start
pause
