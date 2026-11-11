# Generates build/icon.png (256px) and build/icon.ico (multi-size, PNG-compressed).
# YouTube-style red rounded rectangle with a white play triangle.
param([string]$OutDir = (Join-Path $PSScriptRoot '..\build'))
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 960.0

  # Red rounded rectangle (16:11.3, like a screen), white play triangle. 960px grid.
  $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 0, 51))
  $x = 40 * $k; $y = 160 * $k; $w = 880 * $k; $h = 640 * $k; $rad = 190 * $k
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($x, $y, 2 * $rad, 2 * $rad, 180, 90)
  $path.AddArc($x + $w - 2 * $rad, $y, 2 * $rad, 2 * $rad, 270, 90)
  $path.AddArc($x + $w - 2 * $rad, $y + $h - 2 * $rad, 2 * $rad, 2 * $rad, 0, 90)
  $path.AddArc($x, $y + $h - 2 * $rad, 2 * $rad, 2 * $rad, 90, 90)
  $path.CloseFigure()
  $g.FillPath($red, $path)
  $pts = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF (385 * $k), (330 * $k)),
    (New-Object System.Drawing.PointF (385 * $k), (630 * $k)),
    (New-Object System.Drawing.PointF (645 * $k), (480 * $k))
  )
  $g.FillPolygon([System.Drawing.Brushes]::White, $pts)
  $g.Dispose()
  return $bmp
}

$sizes = 256, 64, 48, 32, 24, 16
$pngs = @{}
foreach ($sz in $sizes) {
  $bmp = New-IconBitmap $sz
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs[$sz] = $ms.ToArray()
  if ($sz -eq 256) { $bmp.Save((Join-Path $OutDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
}

# ICO container: header + directory + PNG payloads
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($sz in $sizes) {
  $dim = if ($sz -ge 256) { 0 } else { $sz }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$pngs[$sz].Length); $w.Write([UInt32]$offset)
  $offset += $pngs[$sz].Length
}
foreach ($sz in $sizes) { $w.Write($pngs[$sz]) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $OutDir 'icon.ico'), $out.ToArray())
"Wrote icon.png and icon.ico to $OutDir"
