Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root 'extension/icons'
$sourceIcon = Join-Path $iconDir 'candidates/candidate-20-dark-blue-rounded-sans.png'

if (-not (Test-Path -LiteralPath $sourceIcon)) {
  throw "Source icon is missing: $sourceIcon"
}

New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function Resize-Icon {
  param(
    [Parameter(Mandatory)][System.Drawing.Image]$Source,
    [Parameter(Mandatory)][int]$Size,
    [Parameter(Mandatory)][string]$Path
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($Source, 0, 0, $Size, $Size)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

$targets = [ordered]@{
  'icon-16.png' = 16
  'icon-32.png' = 32
  'icon-48.png' = 48
  'icon-128.png' = 128
  'icon-1024.png' = 1024
}

$source = [System.Drawing.Image]::FromFile($sourceIcon)
try {
  foreach ($entry in $targets.GetEnumerator()) {
    $outPath = Join-Path $iconDir $entry.Key
    Resize-Icon -Source $source -Size $entry.Value -Path $outPath
    Write-Host "Generated $outPath from $sourceIcon"
  }
} finally {
  $source.Dispose()
}
