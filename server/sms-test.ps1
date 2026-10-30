# SMS send test with Solapi settings typed into hidden prompts (nothing is saved or shown).
#   powershell -ExecutionPolicy Bypass -File server\sms-test.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:Path"

function Read-Secret($label) {
  $s = Read-Host $label -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$env:SMS_PROVIDER = 'solapi'
$env:SOLAPI_API_KEY = Read-Secret 'Solapi API Key (hidden)'
$env:SOLAPI_API_SECRET = Read-Secret 'Solapi API Secret (hidden)'
$env:SMS_FROM = Read-Host 'Sender number registered in Solapi (SMS_FROM)'
$to = Read-Host 'Your phone number to receive the test SMS'
try {
  node sms-test.js $to
} finally {
  'SMS_PROVIDER', 'SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SMS_FROM' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
