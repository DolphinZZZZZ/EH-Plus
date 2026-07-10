Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'fixtures/images'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Add-Type -AssemblyName System.Drawing

$fontFamilies = @('Microsoft YaHei', 'SimHei', 'Arial')
$fontFamily = $fontFamilies | Where-Object {
  [System.Drawing.FontFamily]::Families.Name -contains $_
} | Select-Object -First 1

if (-not $fontFamily) {
  $fontFamily = [System.Drawing.FontFamily]::GenericSansSerif.Name
}

for ($i = 1; $i -le 5; $i++) {
  $bitmap = [System.Drawing.Bitmap]::new(320, 180)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::FromArgb(246, 248, 250))

  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(36, 41, 47), 3)
  $graphics.DrawRectangle($pen, 8, 8, 304, 164)

  $font = [System.Drawing.Font]::new($fontFamily, 30, [System.Drawing.FontStyle]::Bold)
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(9, 105, 218))
  $text = "测试图片$i"
  $size = $graphics.MeasureString($text, $font)
  $x = [Math]::Max(12, (320 - $size.Width) / 2)
  $y = [Math]::Max(12, (180 - $size.Height) / 2)
  $graphics.DrawString($text, $font, $brush, $x, $y)

  $path = Join-Path $outDir ('test-image-{0:D3}.png' -f $i)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  $brush.Dispose()
  $font.Dispose()
  $pen.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Host "Generated image fixtures in $outDir"
