# Agoda-2 SNMP check. Run on the customer's Windows PC while it is on the VPN.
# Prompts for the two passphrases. Does not save them and does not change the PDUs.
# Requires snmpget.exe from the Net-SNMP Windows install (default C:\usr\bin\snmpget.exe).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\agoda-snmp-reachability.ps1

$ErrorActionPreference = "Continue"
$SnmpUser = "pduuser"
$AuthProto = "SHA"
$PrivProto = "AES"
$TimeoutSec = 2

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

function Find-SnmpGet {
  $candidates = @(
    "C:\usr\bin\snmpget.exe",
    "C:\Program Files\Net-SNMP\bin\snmpget.exe",
    "$env:ProgramFiles\Net-SNMP\bin\snmpget.exe"
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  $cmd = Get-Command snmpget.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Test-PingHost([string]$Ip) {
  try {
    $ping = New-Object System.Net.NetworkInformation.Ping
    $reply = $ping.Send($Ip, 1000)
    return ($reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success)
  } catch {
    return $false
  }
}

function Test-TcpPort([string]$Ip, [int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $wait = $client.BeginConnect($Ip, $Port, $null, $null)
    $ok = $wait.AsyncWaitHandle.WaitOne(1500, $false)
    if (-not $ok) { return $false }
    $client.EndConnect($wait)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Quote-Arg([string]$Value) {
  if ($null -eq $Value) { return '""' }
  if ($Value.IndexOf(' ') -ge 0 -or $Value.IndexOf('"') -ge 0) {
    return '"' + $Value.Replace('"','\"') + '"'
  }
  return $Value
}

function Invoke-SnmpName([string]$SnmpGet, [string]$Ip, [string]$Auth, [string]$Priv) {
  $parts = @(
    "-v3", "-l", "authPriv", "-u", $SnmpUser,
    "-a", $AuthProto, "-A", $Auth,
    "-x", $PrivProto, "-X", $Priv,
    "-t", "$TimeoutSec", "-r", "0", "-Oqv",
    "${Ip}:161", "1.3.6.1.2.1.1.5.0"
  )
  $argLine = ($parts | ForEach-Object { Quote-Arg $_ }) -join " "
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo.FileName = $SnmpGet
  $proc.StartInfo.Arguments = $argLine
  $proc.StartInfo.UseShellExecute = $false
  $proc.StartInfo.RedirectStandardOutput = $true
  $proc.StartInfo.RedirectStandardError = $true
  $proc.StartInfo.CreateNoWindow = $true
  [void]$proc.Start()
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  if (-not $stdout) { $stdout = "" }
  if (-not $stderr) { $stderr = "" }
  return @{ Out = $stdout.Trim(); Err = ($stderr -replace "\s+", " ").Trim(); Code = $proc.ExitCode }
}

$snmpGet = Find-SnmpGet
$auth = $env:SNMP_AUTH
$priv = $env:SNMP_PRIV
if (-not $auth) { $auth = Read-Host "Paste the SHA passphrase (it will not be saved)" }
if (-not $priv) { $priv = Read-Host "Paste the AES passphrase (it will not be saved)" }
if (-not $auth -or -not $priv) {
  Write-Host "Both passphrases are required."
  exit 2
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outPath = Join-Path (Get-Location) "agoda-snmp-report-$stamp.txt"
$lines = New-Object System.Collections.Generic.List[string]

function Add-Line([string]$Text) {
  $script:lines.Add($Text) | Out-Null
  Write-Host $Text
}

Add-Line "Agoda-2 PDU SNMP reachability"
Add-Line ("Generated: {0:yyyy-MM-dd HH:mm:ss zzz}" -f (Get-Date))
Add-Line ("Runner: {0}  user: {1}" -f $env:COMPUTERNAME, $env:USERNAME)
Add-Line ("SNMP tool: {0}" -f $(if ($snmpGet) { $snmpGet } else { "NOT FOUND" }))
Add-Line "SNMP: v3 authPriv user=pduuser auth=SHA priv=AES  (keys not recorded)"
Add-Line ""
Add-Line "---- path from this PC ----"
try {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike "127.*" } |
    ForEach-Object { Add-Line ("  {0}/{1}  {2}" -f $_.IPAddress, $_.PrefixLength, $_.InterfaceAlias) }
} catch {
  ipconfig | Select-String "IPv4" | ForEach-Object { Add-Line ("  " + $_.Line.Trim()) }
}
foreach ($probe in @("10.106.76.225", "10.106.77.225")) {
  Add-Line ("route to {0}:" -f $probe)
  try {
    $route = Find-NetRoute -RemoteIPAddress $probe -ErrorAction Stop | Select-Object -First 1
    Add-Line ("  if={0} next={1} dest={2}" -f $route.InterfaceAlias, $route.NextHop, $route.DestinationPrefix)
  } catch {
    Add-Line "  (route lookup failed)"
  }
}
Add-Line ""
Add-Line "These PDUs were commissioned SNMPv3 only (v1 off, v2c off), auth SHA, privacy AES."
Add-Line "A monitor using v2c or a community string stays red even when v3 answers."
Add-Line "HTTPS on the web console does not mean SNMP is up. SNMP is UDP 161, separate from TCP 443."
if (-not $snmpGet) {
  Add-Line ""
  Add-Line "WARNING: snmpget.exe was not found. Ping and web ports will still be tested."
  Add-Line "Install Net-SNMP for Windows, then run this script again."
  Add-Line "Default location after install: C:\usr\bin\snmpget.exe"
}
Add-Line ""
Add-Line ("{0,-22} {1,-15} {2,-5} {3,-5} {4,-5} {5,-5} {6,-18} {7}" -f "NAME","IP","PING","TCP80","TCP443","SNMP","CAUSE","DETAIL")
Add-Line ("-" * 110)

$counts = @{ "snmp-ok" = 0; "auth-reject" = 0; "snmp-silent" = 0; "no-path" = 0; "snmp-error" = 0; "no-snmpget" = 0 }

foreach ($pdu in $Pdus) {
  $name = $pdu.Name
  $ip = $pdu.Ip
  $ping = "no"; if (Test-PingHost $ip) { $ping = "yes" }
  $p80 = "no"; if (Test-TcpPort $ip 80) { $p80 = "yes" }
  $p443 = "no"; if (Test-TcpPort $ip 443) { $p443 = "yes" }
  $snmp = "no"
  $cause = ""
  $detail = ""

  if (-not $snmpGet) {
    $cause = "no-snmpget"
    $detail = "snmpget.exe missing"
  } else {
    $result = Invoke-SnmpName $snmpGet $ip $auth $priv
    if ($result.Out -and -not $result.Err) {
      $snmp = "yes"
      $cause = "snmp-ok"
      $detail = "sysName=" + $result.Out
    } else {
      $err = $result.Err
      if ($err -match "uthentication|nknown user|rong digest") {
        $cause = "auth-reject"
      } elseif (-not $err -or $err -match "imeout|o Response") {
        if ($ping -eq "no" -and $p80 -eq "no" -and $p443 -eq "no") { $cause = "no-path" }
        else { $cause = "snmp-silent" }
      } else {
        $cause = "snmp-error"
      }
      if (-not $err) { $err = "no snmp response" }
      if ($err.Length -gt 160) { $err = $err.Substring(0, 160) }
      $detail = $err
    }
  }
  $counts[$cause] = $counts[$cause] + 1
  Add-Line ("{0,-22} {1,-15} {2,-5} {3,-5} {4,-5} {5,-5} {6,-18} {7}" -f $name, $ip, $ping, $p80, $p443, $snmp, $cause, $detail)
}

Add-Line ""
Add-Line "---- how to read the cause column ----"
Add-Line "snmp-ok       This PC got the PDU name over SNMPv3. If the monitor is still red, the monitor"
Add-Line "              is using another version, user, or passphrase, or it polls from another PC."
Add-Line "auth-reject   UDP 161 reached the PDU and the PDU refused the user or the keys."
Add-Line "snmp-silent   Ping and/or the web ports answer, but SNMPv3 got no reply."
Add-Line "              SNMP is off on that PDU, or UDP 161 is filtered on the path."
Add-Line "no-path       No ping, no web, no SNMP. That address is down from this PC."
Add-Line "no-snmpget    SNMP was not tested because snmpget.exe is not installed."
Add-Line "snmp-error    The PDU answered with an unexpected SNMP error. See DETAIL."
Add-Line ""
Add-Line "---- counts ----"
foreach ($key in @("snmp-ok","auth-reject","snmp-silent","no-path","snmp-error","no-snmpget")) {
  Add-Line ("{0,-12} {1}" -f ($key + ":"), $counts[$key])
}
Add-Line ""
Add-Line "Feed A is 10.106.76.225-.231. Feed B is 10.106.77.225-.231."
Add-Line "If failures are snmp-silent while ping or HTTPS works, the path is up and SNMP itself is the fault."
Add-Line "If a whole feed is no-path, that subnet route or VLAN is the fault."
Add-Line ""
Add-Line "Report file: $outPath"

$lines | Set-Content -LiteralPath $outPath -Encoding ASCII
Write-Host ""
Write-Host "Send this file back: $outPath"
