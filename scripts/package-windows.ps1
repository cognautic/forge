$ErrorActionPreference = "Stop"

$release = Join-Path (Resolve-Path ".\dist").Path "release-win"
New-Item -ItemType Directory -Force -Path $release | Out-Null

Copy-Item -Force ".\dist\forge.exe" (Join-Path $release "forge.exe")
Copy-Item -Force ".\scripts\install-windows.ps1" (Join-Path $release "install.ps1")

$zip = ".\dist\cognautic-forge-windows.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path "$release\*" -DestinationPath $zip

Write-Host "Created $zip"
