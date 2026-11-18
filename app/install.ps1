# Chata Thu ngan - cai dat / cap nhat app tren Windows
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$V = '38.7.2'
$base = 'https://taichata123.github.io/baihat/app/'
$dest = Join-Path $env:LOCALAPPDATA 'ChataThuNgan'
$exe = Join-Path $dest 'ChataThuNgan.exe'
Write-Host ''
Write-Host '=== CAI DAT CHATA THU NGAN ===' -ForegroundColor Green
Get-Process ChataThuNgan -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

$ver = ''
if (Test-Path (Join-Path $dest 'version')) { $ver = (Get-Content (Join-Path $dest 'version') -Raw).Trim() }
if (-not (Test-Path $exe) -or $ver -ne $V) {
  Write-Host 'Buoc 1/3: Tai bo chay (khoang 130MB, mat 1-5 phut tuy mang)...'
  $tmp = Join-Path $env:TEMP 'chata-electron.zip'
  Invoke-WebRequest "https://github.com/electron/electron/releases/download/v$V/electron-v$V-win32-x64.zip" -OutFile $tmp -UseBasicParsing
  Write-Host 'Buoc 2/3: Giai nen...'
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Expand-Archive -Path $tmp -DestinationPath $dest -Force
  Remove-Item $tmp -Force
  Rename-Item (Join-Path $dest 'electron.exe') 'ChataThuNgan.exe'
  Remove-Item (Join-Path $dest 'resources\default_app.asar') -ErrorAction SilentlyContinue
} else {
  Write-Host 'Bo chay da co san, chi cap nhat app.'
}

Write-Host 'Buoc 3/3: Tai app Chata...'
$app = Join-Path $dest 'resources\app'
New-Item -ItemType Directory -Force -Path $app | Out-Null
foreach ($f in 'prev', 'update.pending', 'update.failed') { Remove-Item (Join-Path $app $f) -Recurse -Force -ErrorAction SilentlyContinue }
foreach ($f in 'boot.js', 'main.js', 'preload.js', 'package.json') {
  Invoke-WebRequest ($base + $f + '?t=' + [DateTime]::Now.Ticks) -OutFile (Join-Path $app $f) -UseBasicParsing
}

# Bieu tuong: o vuong xanh chu C
try {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 64, 64
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::FromArgb(19, 196, 138))
  $font = New-Object System.Drawing.Font('Arial', 40, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $g.DrawString('C', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 2, 64, 64)), $sf)
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  foreach ($p in (Join-Path $dest 'chata.ico'), (Join-Path $app 'chata.ico')) {
    $fs = [System.IO.File]::Create($p); $icon.Save($fs); $fs.Close()
  }
} catch { Write-Host 'Khong tao duoc bieu tuong, dung bieu tuong mac dinh.' }

$w = New-Object -ComObject WScript.Shell
$ico = Join-Path $dest 'chata.ico'
foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
  $s = $w.CreateShortcut((Join-Path $folder 'Chata Thu ngan.lnk'))
  $s.TargetPath = $exe; $s.WorkingDirectory = $dest; $s.Description = 'Chata Thu ngan'
  if (Test-Path $ico) { $s.IconLocation = $ico + ',0' }
  $s.Save()
}

Write-Host ''
Write-Host 'DA CAI XONG! Bieu tuong "Chata Thu ngan" da co tren man hinh.' -ForegroundColor Green
Write-Host 'App se tu mo moi khi bat may.'
Start-Process $exe
