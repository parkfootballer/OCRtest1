# Run a manage.js command against the PRODUCTION database (Render) without saving the DB address anywhere.
#   powershell -ExecutionPolicy Bypass -File server\run-prod.ps1 api-client-add hso --all
#   powershell -ExecutionPolicy Bypass -File server\run-prod.ps1 api-clients
# Before running: Render > chalkak-db > Access Control must allow this PC's IP.
# The address is typed into a hidden prompt and removed from the environment when the command ends.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ManageArgs)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:Path"

if (-not $ManageArgs) { Write-Host 'Usage: run-prod.ps1 <manage.js command> [args]'; exit 1 }

$secure = Read-Host 'Paste Render External Database URL (input hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $url = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if ($url -notmatch '^postgres(ql)?://') { Write-Host 'That does not look like a database URL (must start with postgres://).'; exit 1 }
if ($url -match '@(localhost|127\.0\.0\.1)[:/]') { Write-Host 'That is a local address. Use the External Database URL from Render.'; exit 1 }

$env:DATABASE_URL = $url
$env:DB_SSL = 'true'
Remove-Variable url
try {
  node manage.js @ManageArgs
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:DB_SSL -ErrorAction SilentlyContinue
}
