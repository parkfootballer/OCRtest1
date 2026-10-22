param([string]$Out)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Out | Out-Null

function RoundRect($g, $brush, $x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
  $p.AddArc($x + $w - 2*$r, $y, 2*$r, 2*$r, 270, 90)
  $p.AddArc($x + $w - 2*$r, $y + $h - 2*$r, 2*$r, 2*$r, 0, 90)
  $p.AddArc($x, $y + $h - 2*$r, 2*$r, 2*$r, 90, 90)
  $p.CloseFigure()
  $g.FillPath($brush, $p)
}

# $maskable: 아이콘 내용을 가운데 80% 안전 영역에 맞추고 배경을 꽉 채운다
function Icon([int]$size, [string]$name, [bool]$maskable, [bool]$rounded) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(37, 99, 235))
  if ($rounded) { RoundRect $g $blue 0 0 $size $size ($size * 0.22) } else { $g.FillRectangle($blue, 0, 0, $size, $size) }

  $s = if ($maskable) { $size * 0.62 } else { $size * 0.78 }
  $ox = ($size - $s) / 2; $oy = ($size - $s) / 2
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $line = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(191, 219, 254))
  # 문서
  $dw = $s * 0.58; $dh = $s * 0.74; $dx = $ox + $s * 0.12; $dy = $oy + $s * 0.08
  RoundRect $g $white $dx $dy $dw $dh ($s * 0.06)
  for ($i = 0; $i -lt 4; $i++) {
    $lw = if ($i -eq 3) { $dw * 0.4 } else { $dw * 0.66 }
    RoundRect $g $line ($dx + $dw * 0.17) ($dy + $dh * (0.2 + $i * 0.15)) $lw ($s * 0.045) ($s * 0.02)
  }
  # 셔터 (오른쪽 아래)
  $cr = $s * 0.24; $cx = $ox + $s * 0.70; $cy = $oy + $s * 0.72
  $g.FillEllipse($blue, $cx - $cr - $s * 0.04, $cy - $cr - $s * 0.04, 2 * ($cr + $s * 0.04), 2 * ($cr + $s * 0.04))
  $g.FillEllipse($white, $cx - $cr, $cy - $cr, 2 * $cr, 2 * $cr)
  $g.FillEllipse($blue, $cx - $cr * 0.62, $cy - $cr * 0.62, 2 * $cr * 0.62, 2 * $cr * 0.62)
  $g.FillEllipse($white, $cx - $cr * 0.42, $cy - $cr * 0.42, 2 * $cr * 0.42, 2 * $cr * 0.42)

  $bmp.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Icon 192 'icon-192.png' $false $true
Icon 512 'icon-512.png' $false $true
Icon 512 'maskable-512.png' $true $false
Icon 180 'apple-touch-icon.png' $false $false
Icon 32 'favicon-32.png' $false $true
Get-ChildItem $Out | Select-Object Name, Length
