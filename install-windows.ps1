#Requires -RunAsAdministrator
<#
.SYNOPSIS
    PDUMind One-Click Installer for Windows
.DESCRIPTION
    Installs Docker Desktop (if needed), clones the PDUMind repo, and launches the application.
    Run this script in an elevated PowerShell terminal (Run as Administrator).
#>

param(
    [string]$InstallDir = "$env:USERPROFILE\PDUMind",
    [string]$RepoUrl = "https://github.com/lnesto74/pdumind-setup.git",
    [string]$Branch = "master"
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "    [X] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  =====================================" -ForegroundColor Cyan
Write-Host "       PDUMind Installer for Windows    " -ForegroundColor White
Write-Host "  =====================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check Windows version ───────────────────────────────────────────
Write-Step "Checking Windows version..."
$osVersion = [System.Environment]::OSVersion.Version
if ($osVersion.Build -lt 18362) {
    Write-Err "Windows 10 version 1903 or later is required for Docker Desktop."
    Write-Err "Please update Windows and try again."
    exit 1
}
Write-Ok "Windows $($osVersion.Major).$($osVersion.Minor) build $($osVersion.Build)"

# ── 2. Enable WSL2 (required by Docker Desktop) ────────────────────────
Write-Step "Ensuring WSL2 is enabled..."
$wslFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
if ($wslFeature.State -ne "Enabled") {
    Write-Warn "Enabling WSL feature (may require reboot)..."
    Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart | Out-Null
}
$vmFeature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
if ($vmFeature.State -ne "Enabled") {
    Write-Warn "Enabling Virtual Machine Platform..."
    Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart | Out-Null
}
Write-Ok "WSL2 prerequisites enabled"

try {
    wsl --set-default-version 2 2>$null | Out-Null
} catch {}

# ── 3. Install Git if missing ──────────────────────────────────────────
Write-Step "Checking Git..."
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Warn "Git not found. Installing via winget..."
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements --silent
    $env:PATH = "$env:ProgramFiles\Git\cmd;$env:PATH"
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        Write-Err "Git installation failed. Please install Git manually: https://git-scm.com"
        exit 1
    }
}
Write-Ok "Git $(git --version)"

# ── 4. Install Docker Desktop if missing ───────────────────────────────
Write-Step "Checking Docker Desktop..."
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
$needsInstall = $false

if (-not $dockerCmd) {
    $needsInstall = $true
} else {
    try {
        docker version 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $needsInstall = $true }
    } catch {
        $needsInstall = $true
    }
}

if ($needsInstall) {
    Write-Warn "Docker Desktop not found. Downloading installer..."

    $dockerInstaller = "$env:TEMP\DockerDesktopInstaller.exe"
    $dockerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"

    Invoke-WebRequest -Uri $dockerUrl -OutFile $dockerInstaller -UseBasicParsing
    Write-Ok "Download complete. Installing Docker Desktop (this may take a few minutes)..."

    Start-Process -FilePath $dockerInstaller -ArgumentList "install", "--quiet", "--accept-license" -Wait -NoNewWindow
    Remove-Item $dockerInstaller -Force -ErrorAction SilentlyContinue

    $env:PATH = "$env:ProgramFiles\Docker\Docker\resources\bin;$env:PATH"

    Write-Warn "Docker Desktop installed. It may need a system restart."
    Write-Warn "After restart, Docker Desktop will start automatically."

    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerCmd) {
        Write-Host ""
        Write-Host "  ============================================" -ForegroundColor Yellow
        Write-Host "   RESTART REQUIRED" -ForegroundColor Yellow
        Write-Host "   Please restart your PC, then run this" -ForegroundColor Yellow
        Write-Host "   script again to finish the installation." -ForegroundColor Yellow
        Write-Host "  ============================================" -ForegroundColor Yellow
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 0
    }
}

Write-Ok "Docker $(docker --version)"

# ── 5. Wait for Docker daemon to be ready ──────────────────────────────
Write-Step "Waiting for Docker Engine to be ready..."
$attempts = 0
$maxAttempts = 30
while ($attempts -lt $maxAttempts) {
    try {
        docker info 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
    } catch {}

    $attempts++
    if ($attempts -eq 1) {
        Write-Warn "Starting Docker Desktop... (this can take up to 2 minutes on first run)"
        Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 5
}

if ($attempts -ge $maxAttempts) {
    Write-Err "Docker Engine did not start in time."
    Write-Err "Please open Docker Desktop manually, wait for it to start, then run this script again."
    exit 1
}
Write-Ok "Docker Engine is running"

# ── 6. Clone or update the repository ──────────────────────────────────
Write-Step "Setting up PDUMind in $InstallDir..."

if (Test-Path "$InstallDir\.git") {
    Write-Warn "Existing installation found. Pulling latest changes..."
    Push-Location $InstallDir
    $env:GIT_REDIRECT_STDERR = '2>&1'
    & git pull origin $Branch 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    Pop-Location
    Write-Ok "Repository updated"
} else {
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
    }
    $env:GIT_REDIRECT_STDERR = '2>&1'
    & git clone --branch $Branch $RepoUrl $InstallDir 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    if (-not (Test-Path "$InstallDir\.git")) {
        Write-Err "Clone failed. Check your internet connection and try again."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Ok "Repository cloned"
}

# ── 7. Create data directories ─────────────────────────────────────────
Write-Step "Preparing data directories..."
$dirs = @("$InstallDir\data", "$InstallDir\data\mibs", "$InstallDir\data\models", "$InstallDir\backend\data", "$InstallDir\backend\data\mibs", "$InstallDir\backend\data\models")
foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-Ok "Data directories ready"

# ── 7b. Detect LAN IP for viewer share URL ─────────────────────────────
Write-Step "Detecting LAN IP for viewer share link..."
$hubIp = $null
try {
    $hubIp = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.PrefixOrigin -ne 'WellKnown' -and
            $_.InterfaceAlias -notlike '*Loopback*'
        } |
        Sort-Object -Property InterfaceMetric |
        Select-Object -First 1).IPAddress
} catch {}

$envFile = Join-Path $InstallDir ".env"
$envLines = @()
if (Test-Path $envFile) {
    $envLines = Get-Content $envFile | Where-Object { $_ -notmatch '^\s*HUB_LAN_IP=' -and $_ -notmatch '^\s*HUB_PORT=' }
}
if ($hubIp) {
    $envLines += "HUB_LAN_IP=$hubIp"
    $envLines += "HUB_PORT=3000"
    $envLines | Set-Content $envFile -Encoding UTF8
    Write-Ok "Hub LAN IP: $hubIp (viewer link: http://${hubIp}:3000/view)"
} else {
    Write-Warn "Could not detect LAN IP — set HUB_LAN_IP in $envFile manually"
}

# ── 8. Build and launch with Docker Compose ────────────────────────────
Write-Step "Building and starting PDUMind (first build takes 3-5 minutes)..."
Push-Location $InstallDir

& docker compose build 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
if ($LASTEXITCODE -ne 0) {
    Write-Err "Docker build failed. Check the output above for errors."
    Pop-Location
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Ok "Build complete"

& docker compose up -d 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
if ($LASTEXITCODE -ne 0) {
    Write-Err "Failed to start containers."
    Pop-Location
    Read-Host "Press Enter to exit"
    exit 1
}

Pop-Location
Write-Ok "PDUMind containers are running"

# ── 9. Wait for services and open browser ──────────────────────────────
Write-Step "Waiting for services to start..."
Start-Sleep -Seconds 8

$attempts = 0
while ($attempts -lt 15) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) { break }
    } catch {}
    $attempts++
    Start-Sleep -Seconds 3
}

# ── 10. Create Desktop shortcut ─────────────────────────────────────────
Write-Step "Creating Desktop shortcut..."
try {
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "PDUMind.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $shortcut = $ws.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $InstallDir "PDUMind.bat"
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.Description = "Launch PDUMind (auto-updates from GitHub)"
    $shortcut.Save()
    Write-Ok "Shortcut created on Desktop"
} catch {
    Write-Warn "Could not create Desktop shortcut. You can run PDUMind.bat from $InstallDir"
}

Write-Host ""
Write-Host "  =====================================" -ForegroundColor Green
Write-Host "   PDUMind is ready!" -ForegroundColor White
Write-Host "  =====================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Frontend:  http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Viewer:    http://localhost:3000/view" -ForegroundColor Cyan
if ($hubIp) {
  Write-Host "  Share URL: http://${hubIp}:3000/view  (colleagues on same network)" -ForegroundColor Green
}
Write-Host "  Backend:   http://localhost:5002" -ForegroundColor Cyan
Write-Host "  Install:   $InstallDir" -ForegroundColor Gray
Write-Host ""
Write-Host "  To launch: Double-click 'PDUMind' on your Desktop" -ForegroundColor Gray
Write-Host "  To stop:   docker compose down  (from $InstallDir)" -ForegroundColor Gray
Write-Host ""

Start-Process "http://localhost:3000"

Write-Host "Press Enter to exit this installer..." -ForegroundColor Gray
Read-Host
