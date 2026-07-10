Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'extension/manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$packageName = 'EH＋-extension-v{0}' -f $manifest.version
$distRoot = Join-Path $root 'dist'
$distDir = Join-Path $distRoot $packageName
$downloadsDir = Join-Path $env:USERPROFILE 'Downloads'
$downloadsPackageDir = Join-Path $downloadsDir $packageName
$zipPath = Join-Path $downloadsDir ($packageName + '.zip')
$copiedToDownloads = $false

function Reset-Directory {
  param([Parameter(Mandatory)][string]$Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

& (Join-Path $root 'scripts/generate-icons.ps1')
if ($LASTEXITCODE -ne 0) {
  node (Join-Path $root 'scripts/generate-icons.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
}

Reset-Directory -Path $distDir
Get-ChildItem -LiteralPath (Join-Path $root 'extension') | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $distDir -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $root 'shared') -Destination (Join-Path $distDir 'shared') -Recurse -Force
$serviceWorkerPath = Join-Path $distDir 'service-worker.js'
(Get-Content -LiteralPath $serviceWorkerPath -Raw).Replace('../shared/', './shared/') | Set-Content -LiteralPath $serviceWorkerPath -NoNewline

if (Test-Path -LiteralPath $downloadsPackageDir) {
  try {
    Remove-Item -LiteralPath $downloadsPackageDir -Recurse -Force -ErrorAction Stop
  } catch {
    Write-Warning "Could not remove locked Downloads package; mirroring with robocopy instead."
    New-Item -ItemType Directory -Force -Path $downloadsPackageDir | Out-Null
    robocopy $distDir $downloadsPackageDir /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    if ($LASTEXITCODE -ge 8) {
      throw "robocopy failed with exit code $LASTEXITCODE"
    }
    $copiedToDownloads = $true
  }
}
if (-not $copiedToDownloads) {
  Copy-Item -LiteralPath $distDir -Destination $downloadsPackageDir -Recurse -Force
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
$archiveItems = Get-ChildItem -LiteralPath $distDir | Select-Object -ExpandProperty FullName
Compress-Archive -LiteralPath $archiveItems -DestinationPath $zipPath -Force

Write-Host "Built extension directory: $distDir"
Write-Host "Copied unpacked extension to: $downloadsPackageDir"
Write-Host "Created zip package: $zipPath"
