# Tunnel watchdog: keeps serveo tunnel alive and worker BRIDGE_URL in sync
# Runs as a loop - check tunnel every 30s, restart + update URL if dead

$LOG = "$env:TEMP\telegram-tunnel-watch.log"
$TUNNEL_URL = "D:\claude\telegram-mcp\.tunnel-url"
$LAST_KNOWN = ""
if (Test-Path $TUNNEL_URL) { $LAST_KNOWN = (Get-Content $TUNNEL_URL -Raw).Trim() }

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'HH:mm:ss') $msg"
  Add-Content -Path $LOG -Value $line -ErrorAction SilentlyContinue
}

function Start-Tunnel {
  $proc = Start-Process ssh -ArgumentList @(
    "-i", "$env:USERPROFILE\.ssh\id_ed25519",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-R", "80:localhost:8765",
    "serveo.net"
  ) -RedirectStandardOutput "$env:TEMP\tunnel-out.txt" -RedirectStandardError "$env:TEMP\tunnel-err.txt" -NoNewWindow -PassThru
  Write-Log "Tunnel started PID $($proc.Id)"

  # Wait for URL (up to 60s)
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $out = ""
    if (Test-Path "$env:TEMP\tunnel-err.txt") { $out = Get-Content "$env:TEMP\tunnel-err.txt" -Raw -ErrorAction SilentlyContinue }
    if (Test-Path "$env:TEMP\tunnel-out.txt") { $out += Get-Content "$env:TEMP\tunnel-out.txt" -Raw -ErrorAction SilentlyContinue }
    $match = [regex]::Match($out, "https://([a-z0-9-]+\.)?serveousercontent\.com")
    if ($match.Success) {
      $url = $match.Value.TrimEnd('/')
      Write-Log "Tunnel URL: $url"
      $url | Out-File $TUNNEL_URL
      # Update worker secret if changed
      if ($LAST_KNOWN -ne $url) {
        Write-Log "Updating worker BRIDGE_URL to $url"
        Push-Location "D:\claude\telegram-worker"
        $secret = ($url | & npx wrangler secret put BRIDGE_URL 2>&1 | Out-String)
        Write-Log "wrangler: $secret"
        Pop-Location
        $LAST_KNOWN = $url
      }
      return $true
    }
  }
  Write-Log "FAILED: no URL detected"
  return $false
}

# Main loop
while ($true) {
  $sshRunning = Get-Process ssh -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*ssh*" }
  if (-not $sshRunning) {
    Write-Log "Tunnel dead, restarting..."
    Start-Tunnel
  } else {
    # Check tunnel URL responds
    if ($LAST_KNOWN) {
      try {
        $resp = Invoke-WebRequest -Uri "$LAST_KNOWN/api/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -ne 200) { Write-Log "Tunnel URL dead, restarting"; Stop-Process -Name ssh -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Start-Tunnel }
      } catch {
        Write-Log "Tunnel health check failed, restarting"
        Stop-Process -Name ssh -Force -ErrorAction SilentlyContinue
        Start-Sleep 2
        Start-Tunnel
      }
    }
  }
  Start-Sleep -Seconds 30
}
