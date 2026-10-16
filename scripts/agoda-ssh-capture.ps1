# Agoda-2 SSH session capture. Windows PowerShell.
#
# UNTESTED on the customer network. This does not change any PDU.
# These units are not APC. APC SSH commands are not sent.
# The script logs in, asks the firmware for its own command list, and saves it.
#
# Yesterday's sheet is already listed below: addresses, hostnames, NTP, DNS.
# SSH login is the web superuser (admin). The script asks for that password.
# It does not store the password.
#
#   powershell -ExecutionPolicy Bypass -File .\agoda-ssh-capture.ps1
#
# Requires OpenSSH Client (Windows optional feature) and, for the login,
# the Posh-SSH module. If the module is missing the script offers to install
# it for the current user only.

$ErrorActionPreference = "Continue"

$Ntp1 = "ntp1-sin1.network.agoda.local"
$Ntp2 = "ntp2-sin1.network.agoda.local"
$Dns1 = "10.106.16.3"
$Dns2 = "10.123.16.3"
$SnmpUser = "pduuser"
$SnmpAuth = "SHA"
$SnmpPriv = "AES"
$ConsoleUser = "ITGNIALL"

$Pdus = @(
  @{ Name = "SIN1-PDU-2NBM04-A"; Ip = "10.106.76.225" },
  @{ Name = "SIN1-PDU-2NBM04-B"; Ip = "10.106.77.225" },
  @{ Name = "SIN1-PDU-2NBM05-A"; Ip = "10.106.76.226" },
  @{ Name = "SIN1-PDU-2NBM05-B"; Ip = "10.106.77.226" },
  @{ Name = "SIN1-PDU-2NBM06-A"; Ip = "10.106.76.227" },
  @{ Name = "SIN1-PDU-2NBM06-B"; Ip = "10.106.77.227" },
  @{ Name = "SIN1-PDU-2NBM07-A"; Ip = "10.106.76.228" },
  @{ Name = "SIN1-PDU-2NBM07-B"; Ip = "10.106.77.228" },
  @{ Name = "SIN1-PDU-2NBM08-A"; Ip = "10.106.76.229" },
  @{ Name = "SIN1-PDU-2NBM08-B"; Ip = "10.106.77.229" },
  @{ Name = "SIN1-PDU-2NBM09-A"; Ip = "10.106.76.230" },
  @{ Name = "SIN1-PDU-2NBM09-B"; Ip = "10.106.77.230" },
  @{ Name = "SIN1-PDU-2NBM10-A"; Ip = "10.106.76.231" },
  @{ Name = "SIN1-PDU-2NBM10-B"; Ip = "10.106.77.231" }
)

function Test-TcpPort([string]$Ip, [int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $wait = $client.BeginConnect($Ip, $Port, $null, $null)
    $ok = $wait.AsyncWaitHandle.WaitOne(2000, $false)
    if (-not $ok) { return $false }
    $client.EndConnect($wait)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Ensure-PoshSSH {
  if (Get-Module -ListAvailable -Name Posh-SSH) {
    Import-Module Posh-SSH -ErrorAction Stop
    return $true
  }
  Write-Host "Posh-SSH is not installed. It is only used to log in."
  $answer = Read-Host "Install Posh-SSH for the current Windows user? [y/N]"
  if ($answer -notmatch '^[yY]') { return $false }
  try {
    Install-Module -Name Posh-SSH -Scope CurrentUser -Force -AllowClobber
    Import-Module Posh-SSH -ErrorAction Stop
    return $true
  } catch {
    Write-Host "Could not install Posh-SSH: $($_.Exception.Message)"
    return $false
  }
}

$sshUser = Read-Host "SSH username [admin]"
if (-not $sshUser) { $sshUser = "admin" }
$sshPass = Read-Host "SSH password (not saved)"
if (-not $sshPass) {
  Write-Host "Password required."
  exit 2
}

$haveSsh = Ensure-PoshSSH
$secure = ConvertTo-SecureString $sshPass -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ($sshUser, $secure)
$sshPass = $null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outPath = Join-Path (Get-Location) "agoda-ssh-capture-$stamp.txt"
$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$Text) {
  $script:lines.Add($Text) | Out-Null
  Write-Host $Text
}

Add-Line "Agoda-2 SSH command capture"
Add-Line ("Generated: {0:yyyy-MM-dd HH:mm:ss zzz}" -f (Get-Date))
Add-Line ("Runner: {0}" -f $env:COMPUTERNAME)
Add-Line "This run does not change PDU settings."
Add-Line ""
Add-Line "Target parameters from the Agoda sheet (not applied by this script):"
Add-Line ("  NTP1 {0}" -f $Ntp1)
Add-Line ("  NTP2 {0}  (this firmware web page has only one NTP field)" -f $Ntp2)
Add-Line ("  DNS  {0}  {1}" -f $Dns1, $Dns2)
Add-Line ("  SNMP user {0}  auth {1}  privacy {2}" -f $SnmpUser, $SnmpAuth, $SnmpPriv)
Add-Line ("  Web console user {0}  (general user, superuser left unchanged)" -f $ConsoleUser)
Add-Line "  HTTPS was requested. SSH on this firmware is not the APC command set."
Add-Line ""

if (-not $haveSsh) {
  Add-Line "STOPPED: Posh-SSH is not available, so no login was attempted."
  $lines | Set-Content -LiteralPath $outPath -Encoding ASCII
  Write-Host "Send this file back: $outPath"
  exit 2
}

foreach ($pdu in $Pdus) {
  Add-Line ("==== {0}  {1} ====" -f $pdu.Name, $pdu.Ip)
  if (-not (Test-TcpPort $pdu.Ip 22)) {
    Add-Line "port 22 closed. SSH is not listening. Nothing was changed."
    Add-Line ""
    continue
  }
  $session = $null
  try {
    $session = New-SSHSession -ComputerName $pdu.Ip -Credential $cred -AcceptKey -ConnectionTimeout 8 -ErrorAction Stop
    $stream = New-SSHShellStream -SessionId $session.SessionId -TerminalName "vt100" -Columns 120 -Rows 40
    Start-Sleep -Seconds 1
    $banner = $stream.Read()
    foreach ($cmd in @("?", "help")) {
      $stream.WriteLine($cmd)
      Start-Sleep -Seconds 1
    }
    $stream.WriteLine("exit")
    Start-Sleep -Seconds 1
    $text = $banner + $stream.Read()
    if (-not $text) { $text = "(connected, no text returned)" }
    Add-Line $text.TrimEnd()
  } catch {
    Add-Line ("login or session failed: {0}" -f $_.Exception.Message)
  } finally {
    if ($session) {
      Remove-SSHSession -SessionId $session.SessionId -ErrorAction SilentlyContinue | Out-Null
    }
  }
  Add-Line ""
}

Add-Line "Send this file back. The text under each PDU is the command list that firmware actually has."
Add-Line "Do not run APC commands against this list."
$lines | Set-Content -LiteralPath $outPath -Encoding ASCII
Write-Host ""
Write-Host "Send this file back: $outPath"
