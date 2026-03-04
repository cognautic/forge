$ErrorActionPreference = "Stop"

function LogStep($msg) {
  Write-Host "[forge-package:windows] $msg"
}

LogStep "step 1/6: resolving release output directory"
$release = Join-Path (Resolve-Path ".\dist").Path "release-win"
New-Item -ItemType Directory -Force -Path $release | Out-Null

LogStep "step 2/6: copying forge.exe"
Copy-Item -Force ".\dist\forge.exe" (Join-Path $release "forge.exe")

LogStep "step 3/6: copying installer script"
Copy-Item -Force ".\scripts\install-windows.ps1" (Join-Path $release "install.ps1")

LogStep "step 4/6: resolving output archive path"
$zip = ".\dist\cognautic-forge-windows.zip"

LogStep "step 5/6: removing previous archive if present"
if (Test-Path $zip) { Remove-Item -Force $zip }

LogStep "step 6/6: creating archive"
Compress-Archive -Path "$release\*" -DestinationPath $zip
Write-Host "Created $zip"
