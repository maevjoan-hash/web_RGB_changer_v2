# --- RGB Changer: малък уеб сървър за Windows ---
# Браузърът позволява връзка с устройства (WebHID, Web Serial) само за сайтове през https:// или http://localhost,
# не за файл, отворен с двоен клик. Скриптът показва сайта на http://localhost:8080 с вградения в Windows
# PowerShell (HttpListener) – нищо не се инсталира. Пуска се от start.bat; спира се, като затвориш прозореца.
# Адресът е винаги един и същ, защото браузърът пази настройките и разрешенията за устройства по адрес.
param(
  [int]$Port = 8080,
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
# Кирилицата да се чете и когато изходът отива в терминала на VS Code
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'
  '.png' = 'image/png'
  '.jpg' = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif' = 'image/gif'
  '.webp' = 'image/webp'
  '.ico' = 'image/x-icon'
  '.woff2' = 'font/woff2'
  '.txt' = 'text/plain; charset=utf-8'
  '.md' = 'text/plain; charset=utf-8'
}

# Сървърът вече работи (start.bat е пуснат втори път), ако на порта отговаря този сайт
function Test-OurSite([int]$p) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$p/i18n.js"
    return $response.Content -match 'const I18n'
  } catch {
    return $false
  }
}

# WebHID и Web Serial има само в браузърите на Chromium; Edge е във всеки Windows 10/11
function Open-Browser([string]$url) {
  $choice = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
  $progId = (Get-ItemProperty -Path $choice -ErrorAction SilentlyContinue).ProgId
  if ($progId -match 'MSEdge|Chrome|Brave|Opera|Vivaldi') {
    Start-Process $url
  } else {
    Start-Process 'msedge' $url
  }
}

function Send-File($context) {
  $request = $context.Request
  $response = $context.Response
  try {
    $path = [Uri]::UnescapeDataString($request.Url.AbsolutePath)
    if ($path.EndsWith('/')) { $path += 'index.html' }
    $segments = $path.TrimStart('/').Split('/')
    $file = $null
    if ($request.HttpMethod -notin 'GET', 'HEAD') {
      $status = 405
    } elseif ($segments | Where-Object { $_ -eq '' -or $_.StartsWith('.') -or $_ -match '[\\:*?"<>|]' }) {
      # Скритите файлове (.git, .vscode) и опитите за излизане от папката на сайта не се дават
      $status = 404
    } else {
      $full = [IO.Path]::GetFullPath((Join-Path $Root ($segments -join '\')))
      if ($full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
        $file = $full
        $status = 200
      } else {
        $status = 404
      }
    }

    $response.StatusCode = $status
    # Без кеш: промените по сайта се виждат при обикновено презареждане
    $response.Headers['Cache-Control'] = 'no-cache'
    $response.Headers['X-Content-Type-Options'] = 'nosniff'
    if ($file) {
      $extension = [IO.Path]::GetExtension($file).ToLowerInvariant()
      $response.ContentType = if ($types.ContainsKey($extension)) { $types[$extension] } else { 'application/octet-stream' }
      $bytes = [IO.File]::ReadAllBytes($file)
    } else {
      $response.ContentType = 'text/plain; charset=utf-8'
      $bytes = [Text.Encoding]::UTF8.GetBytes("$status")
    }
    $response.ContentLength64 = $bytes.Length
    if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($bytes, 0, $bytes.Length) }
  } catch {
    # Браузърът е прекъснал заявката – няма какво да се направи
  } finally {
    try { $response.Close() } catch { }
  }
}

Write-Host 'RGB Changer: стартиране на сървъра…'
$listener = $null
foreach ($candidatePort in $Port..($Port + 9)) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://localhost:$candidatePort/")
  try {
    $candidate.Start()
    $listener = $candidate
    break
  } catch {
    $candidate.Close()
    if (Test-OurSite $candidatePort) {
      $url = "http://localhost:$candidatePort/"
      Write-Host "Сайтът вече работи на $url"
      if (-not $NoBrowser) { Open-Browser $url }
      exit 0
    }
  }
}

if (-not $listener) {
  Write-Host "Портовете $Port–$($Port + 9) са заети от други програми. Пусни start.bat отново, след като ги затвориш."
  exit 1
}

$url = $listener.Prefixes | Select-Object -First 1
if ($url -ne "http://localhost:$Port/") {
  Write-Host "Портът $Port е зает от друга програма. Запазените настройки и разрешенията за устройства в браузъра са за адреса http://localhost:$Port/ и на новия адрес ще започнат наново."
}
Write-Host "RGB Changer работи на $url"
Write-Host 'Не затваряй този прозорец, докато ползваш сайта. Затвори го, за да спреш сайта.'
if (-not $NoBrowser) { Open-Browser $url }

try {
  while ($listener.IsListening) {
    # Чакане на части, за да може Ctrl+C да спре сървъра
    $pending = $listener.BeginGetContext($null, $null)
    while (-not $pending.AsyncWaitHandle.WaitOne(500)) { }
    Send-File $listener.EndGetContext($pending)
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
