# Crop a logo to a square 256x256 PNG for the worker shortcut icon.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make_worker_icon.ps1 -Source "C:\path\logo.png"
#
# Windows-only on purpose: System.Drawing is already on every Windows box, and the icon it feeds
# is a Windows shortcut. Doing it here means the repo needs no image library (the worker bundle
# ships with no node_modules at all), and the crop is centre-weighted so a portrait logo loses
# equal amounts top and bottom instead of being squashed.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Out = "worker-bundle\Alphadome-256.png",
  [int]$Size = 256
)

Add-Type -AssemblyName System.Drawing

$path = (Resolve-Path -LiteralPath $Source).Path
$img = [System.Drawing.Image]::FromFile($path)
try {
  $side = [Math]::Min($img.Width, $img.Height)
  $x = [int](($img.Width - $side) / 2)
  $y = [int](($img.Height - $side) / 2)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $src = New-Object System.Drawing.Rectangle($x, $y, $side, $side)
    $dst = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
    $g.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
  } finally {
    $g.Dispose()
  }

  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  # Say what happened in numbers, so "it looks small" can be checked instead of argued about.
  Write-Output "source : $path ($($img.Width)x$($img.Height))"
  Write-Output "crop   : ${side}x${side} at ${x},${y}"
  Write-Output "output : $Out (${Size}x${Size})"
} finally {
  $img.Dispose()
}
