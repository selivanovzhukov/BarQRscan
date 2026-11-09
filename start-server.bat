
@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запуск постійного локального HTTPS/HTTP сервера для тестування сканера...
node server.js
pause
