# luma installer for Windows PowerShell.
#
# Builds the project in-place and adds bin/ to the user PATH
# so that `luma` is available in new terminals.
#
# Usage:
#   .\install.ps1              # interactive
#   .\install.ps1 -AssumeYes   # unattended
#
# Requires: node 20+, npm.

[CmdletBinding()]
param(
    [switch]$AssumeYes
)

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $src 'bin'

Write-Host "luma install" -ForegroundColor White
Write-Host "  source: $src" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. Check node >= 20
# ---------------------------------------------------------------------------
try {
    $nodeVersion = (& node -e "process.stdout.write(process.versions.node)" 2>$null)
} catch {
    Write-Error "node is not installed or not on PATH. luma requires Node.js 20+: https://nodejs.org/"
    exit 1
}
if (-not $nodeVersion) {
    Write-Error "node is not installed or not on PATH. luma requires Node.js 20+: https://nodejs.org/"
    exit 1
}
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 20) {
    Write-Error "node $nodeVersion found, but luma requires node 20+"
    exit 1
}

try {
    & npm --version | Out-Null
} catch {
    Write-Error "npm is not installed or not on PATH"
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> Building" -ForegroundColor Cyan

Push-Location $src
try {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} catch {
    Pop-Location
    Write-Error "Build failed: $($_.Exception.Message)"
    exit 1
} finally {
    Pop-Location
}

Write-Host "  [OK]   build complete" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 3. PATH wiring
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> PATH" -ForegroundColor Cyan

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathArr  = if ($userPath) { $userPath -split ';' } else { @() }
if ($pathArr -contains $binDir) {
    Write-Host "  [OK]   $binDir already on user PATH" -ForegroundColor Green
} else {
    $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $binDir } else { "$binDir;$userPath" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "  [OK]   added $binDir to user PATH" -ForegroundColor Green
    Write-Host "         restart your terminal for the change to take effect" -ForegroundColor DarkGray
}
# Make it visible inside this session too.
if (";$env:Path;" -notlike "*;$binDir;*") { $env:Path = "$binDir;$env:Path" }

# ---------------------------------------------------------------------------
# 4. Verify
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> Verification" -ForegroundColor Cyan

$verified = $false
try {
    $lumaBin = Join-Path $binDir 'luma.cmd'
    if (Test-Path $lumaBin) {
        & $lumaBin status 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $verified = $true }
    }
} catch { }

if ($verified) {
    Write-Host "  [OK]   luma status works" -ForegroundColor Green
} else {
    Write-Host "  [INFO] run 'luma status' manually after opening a new terminal" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "done. open a new terminal and try: luma status" -ForegroundColor Green
