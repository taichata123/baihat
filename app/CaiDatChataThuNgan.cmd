@echo off
title Cai dat Chata Thu ngan
echo Dang ket noi may chu Chata...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; iex ((New-Object Net.WebClient).DownloadString('https://taichata123.github.io/baihat/app/install.ps1?t=' + [DateTime]::Now.Ticks))"
if errorlevel 1 (
  echo.
  echo Cai dat chua xong. Kiem tra mang Internet roi chay lai file nay.
)
echo.
pause
