$ErrorActionPreference = "Stop"

function LogStep($msg) {
  Write-Host "[forge-install:windows] $msg"
}

LogStep "step 1/10: loading configuration"
$repo = if ($env:FORGE_REPO) { $env:FORGE_REPO } else { "cognautic/forge" }
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"
LogStep "repo=$repo"

LogStep "step 2/10: fetching latest release metadata"
$release = Invoke-RestMethod -Uri $apiUrl

LogStep "step 3/10: resolving windows asset"
$asset = $release.assets | Where-Object { $_.name -eq "cognautic-forge-windows.zip" } | Select-Object -First 1
if (-not $asset) { throw "Could not find cognautic-forge-windows.zip in latest release for $repo" }
LogStep "asset=$($asset.browser_download_url)"

LogStep "step 4/10: preparing temp directory"
$tempDir = Join-Path $env:TEMP "cognautic-forge-install"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$zipPath = Join-Path $tempDir "forge.zip"

LogStep "step 5/10: downloading archive"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath

LogStep "step 6/10: extracting archive"
Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force

LogStep "step 7/10: preparing target directory"
$targetDir = Join-Path $env:LOCALAPPDATA "CognauticForge\bin"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

LogStep "step 8/10: installing forge.exe"
Copy-Item -Force (Join-Path $tempDir "forge.exe") (Join-Path $targetDir "forge.exe")

LogStep "step 9/10: ensuring PATH includes target directory"
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$targetDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$currentPath;$targetDir", "User")
  LogStep "updated user PATH"
} else {
  LogStep "user PATH already contains target directory"
}

LogStep "step 10/10: completed"
Write-Host "Installed forge.exe to $targetDir"
Write-Host "Open a new terminal and run: forge"
