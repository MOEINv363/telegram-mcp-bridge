# Self-updating serveo tunnel: starts tunnel, detects URL, updates worker BRIDGE_URL
$ErrorActionPreference = "Continue"

$LOG = "$env:TEMP\telegram-tunnel.log"
$WORKER_DIR = "D:\claude\telegram-worker"
$LAST_URL_FILE = "D:\claude\telegram-mcp\.tunnel-url"

# Start serveo tunnel, capture output
$proc = Start-Process ssh -ArgumentList @(
  "-i", "$env:USERPROFILE\.ssh\id_ed25519",
  "-o", "StrictHostKeyChecking=no",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-o", "ExitOnForwardFailure=yes",
  "-R", "80:localhost:8765",
  "serveo.net"
) -RedirectStandardOutput "$env:TEMP\tunnel-out.txt" -RedirectStandardError "$env:TEMP\tunnel-err.txt" -NoNewWindow -PassThru

Write-Output "Tunnel started PID: $($proc.Id)" | Out-File $LOG

# Wait for URL to appear in output (up to 60s)
$url = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  $out = ""
  if (Test-Path "$env:TEMP\tunnel-err.txt") { $out = Get-Content "$env:TEMP\tunnel-err.txt" -Raw -ErrorAction SilentlyContinue }
  if (Test-Path "$env:TEMP\tunnel-out.txt") { $out += Get-Content "$env:TEMP\tunnel-out.txt" -Raw -ErrorAction SilentlyContinue }
  $match = [regex]::Match($out, "https://([a-z0-9-]+\.)?serveousercontent\.com")
  if ($match.Success) {
    $url = $match.Value.TrimEnd('/')
    break
  }
}

if (-not $url) {
  Write-Output "FAILED: no URL detected after 60s" | Out-File $LOG -Append
  exit 1
}

Write-Output "Tunnel URL: $url" | Out-File $LOG -Append

# Update worker secret if URL changed (compare BEFORE writing new value)
$old = ""
if (Test-Path $LAST_URL_FILE) { $old = (Get-Content $LAST_URL_FILE -Raw).Trim() }
if ($old -ne $url) {
  Write-Output "Updating worker BRIDGE_URL to $url..." | Out-File $LOG -Append
  Push-Location $WORKER_DIR
  $secret = ($url | & npx wrangler secret put BRIDGE_URL 2>&1 | Out-String)
  Write-Output $secret | Out-File $LOG -Append
  Pop-Location
  $url | Out-File $LAST_URL_FILE
} else {
  Write-Output "URL unchanged, no update needed" | Out-File $LOG -Append
}
