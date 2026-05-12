<#
.SYNOPSIS
    PDUMind Launcher with Auto-Update
.DESCRIPTION
    Checks GitHub for updates, pulls and rebuilds if needed, then starts PDUMind.
    Double-click PDUMind.bat to run this, or run directly in PowerShell.
#>

param(
    [string]$InstallDir = "",
    [string]$Branch = "master"
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

if (-not $InstallDir) {
    $InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (-not $InstallDir) { $InstallDir = Get-Location }
}

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "    [X] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  =====================================" -ForegroundColor Cyan
Write-Host "         PDUMind Launcher               " -ForegroundColor White
Write-Host "  =====================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $InstallDir

# ── 1. Ensure Docker is running ─────────────────────────────────────────
Write-Step "Checking Docker..."
$dockerOk = $false
try {
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
} catch {}

if (-not $dockerOk) {
    Write-Warn "Docker not running. Starting Docker Desktop..."
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -ErrorAction SilentlyContinue

    $attempts = 0
    while ($attempts -lt 24) {
        Start-Sleep -Seconds 5
        try {
            docker info 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { $dockerOk = $true; break }
        } catch {}
        $attempts++
    }

    if (-not $dockerOk) {
        Write-Err "Docker did not start in time. Please open Docker Desktop manually and try again."
        Read-Host "Press Enter to exit"
        exit 1
    }
}
Write-Ok "Docker is running"

# ── 2. Check for updates ────────────────────────────────────────────────
Write-Step "Checking for updates..."
$needsBuild = $false

try {
    git fetch origin $Branch 2>$null | Out-Null

    $localHash  = (git rev-parse HEAD 2>$null).Trim()
    $remoteHash = (git rev-parse "origin/$Branch" 2>$null).Trim()

    if ($localHash -ne $remoteHash) {
        Write-Warn "Update available! Downloading..."
        git pull origin $Branch 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Code updated"
            $needsBuild = $true
        } else {
            Write-Warn "Pull failed (maybe local changes). Forcing update..."
            git reset --hard "origin/$Branch" 2>&1
            $needsBuild = $true
        }
    } else {
        Write-Ok "Already up to date"
    }
} catch {
    Write-Warn "Could not check for updates (no internet?). Starting with current version."
}

# ── 3. Build if needed ──────────────────────────────────────────────────
if ($needsBuild) {
    Write-Step "Rebuilding containers (this may take a few minutes)..."
    $commitHash  = (git rev-parse --short HEAD 2>$null).Trim()
    $commitCount = (git rev-list --count HEAD 2>$null).Trim()
    $pkgVersion  = (Get-Content "$PSScriptRoot\frontend\package.json" | ConvertFrom-Json).version
    $env:BUILD_VERSION = "$pkgVersion-b$commitCount.$commitHash"
    Write-Host "  Version: $env:BUILD_VERSION" -ForegroundColor DarkGray
    docker compose build 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Build complete"
    } else {
        Write-Warn "Build had issues, trying to start with existing images..."
    }
}

# ── 4. Start containers ─────────────────────────────────────────────────
Write-Step "Starting PDUMind..."
docker compose up -d 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "Failed to start containers."
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Ok "Containers started"

# ── 5. Wait for frontend and open browser ────────────────────────────────
Write-Step "Waiting for PDUMind to be ready..."
$ready = $false
$attempts = 0
while ($attempts -lt 20) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    $attempts++
    Start-Sleep -Seconds 3
}

if ($ready) {
    Write-Host ""
    Write-Host "  =====================================" -ForegroundColor Green
    Write-Host "   PDUMind is ready!" -ForegroundColor White
    Write-Host "  =====================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Open: http://localhost:3000" -ForegroundColor Cyan
    Write-Host ""
    Start-Process "http://localhost:3000"
} else {
    Write-Warn "PDUMind is starting but taking longer than expected."
    Write-Warn "Try opening http://localhost:3000 in your browser manually."
}

Start-Sleep -Seconds 3
