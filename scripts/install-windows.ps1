$ErrorActionPreference = "Stop"

$repo = if ($env:FORGE_REPO) { $env:FORGE_REPO } else { "cognautic/forge" }
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"
$release = Invoke-RestMethod -Uri $apiUrl
$asset = $release.assets | Where-Object { $_.name -eq "cognautic-forge-windows.zip" } | Select-Object -First 1
if (-not $asset) { throw "Could not find cognautic-forge-windows.zip in latest release for $repo" }

$tempDir = Join-Path $env:TEMP "cognautic-forge-install"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$zipPath = Join-Path $tempDir "forge.zip"

Write-Host "Downloading $($asset.browser_download_url)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force

$targetDir = Join-Path $env:LOCALAPPDATA "CognauticForge\bin"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -Force (Join-Path $tempDir "forge.exe") (Join-Path $targetDir "forge.exe")

$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$targetDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$currentPath;$targetDir", "User")
  Write-Host "Added $targetDir to user PATH"
}

Write-Host "Installed forge.exe to $targetDir"
Write-Host "Open a new terminal and run: forge"
