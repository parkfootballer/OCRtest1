# PostgreSQL(C:\pgsql)이 꺼져 있으면 켜고, API 서버를 실행한다.
#   powershell -ExecutionPolicy Bypass -File server\start.ps1
$ErrorActionPreference = 'Stop'
$pg = 'C:\pgsql'
& "$pg\bin\pg_isready.exe" -h localhost -p 5432 -q
if ($LASTEXITCODE -ne 0) {
  & "$pg\bin\pg_ctl.exe" -D "$pg\data" -l "$pg\server.log" -o "-p 5432 -c listen_addresses=localhost" -w start
}
$env:Path = "C:\Program Files\nodejs;$env:Path"
Set-Location $PSScriptRoot
node --env-file=.env server.js
