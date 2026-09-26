# VEXO Connect store print agent — install, update and remove on a Windows till.
#
# Run from an elevated PowerShell in the unpacked release directory:
#
#   .\install\windows-service.ps1 -Install -Server https://pos.example.com -EnrolCode pae_xxxxx
#   .\install\windows-service.ps1 -Update
#   .\install\windows-service.ps1 -Uninstall
#
# WHY A SCHEDULED TASK AND NOT A SERVICE
# A Windows service must answer the Service Control Manager's protocol. Node
# does not, so `sc.exe create` produces a service that reports "did not respond
# in a timely fashion" and is then assumed broken by whoever finds it. Wrapping
# Node in a helper (nssm, node-windows) would work, but the agent ships with
# zero dependencies deliberately — that is what makes the installed bytes
# reviewable — so a scheduled task registered to run as SYSTEM at boot is used
# instead. It restarts on failure, survives logoff, and needs nothing bundled.
#
# PRINTER CONNECTION
# The printer in the pilot store is wired by USB, driver POS-80C on USB001. The
# agent writes raw ESC/POS and cannot go through a Windows driver, so a USB
# printer needs a share so that a UNC path exists:
#
#   net share POS80=  /grant:Everyone,FULL     # no: shares need a printer, see below
#   # Share the printer in Printers & Scanners → POS-80C → Printer properties →
#   # Sharing → Share this printer → share name POS80. Then:
#   #   config set printerTransport=FILE
#   #   config set printerHost=\\localhost\POS80
#
# The same unit also has a LAN port. If it is given an address, TCP/9100 is the
# better path: it has a status channel, so the drawer sensor can be read, which
# the FILE transport can never do. -PrinterHost below accepts either.

[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Install')][switch]$Install,
  [Parameter(ParameterSetName = 'Update')][switch]$Update,
  [Parameter(ParameterSetName = 'Uninstall')][switch]$Uninstall,

  [Parameter(ParameterSetName = 'Install')][string]$Server,
  [Parameter(ParameterSetName = 'Install')][string]$EnrolCode,
  [Parameter(ParameterSetName = 'Install')][string]$PrinterHost,
  [Parameter(ParameterSetName = 'Install')][ValidateSet('TCP', 'FILE')][string]$Transport = 'TCP',
  [Parameter(ParameterSetName = 'Install')][int]$PrinterPort = 9100,

  # Removes the credential and the journal as well. An unfinished job in that
  # journal is the only local record that bytes were in flight, so this is
  # refused unless asked for explicitly.
  [Parameter(ParameterSetName = 'Uninstall')][switch]$Purge
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName  = 'VEXO Print Agent'
$InstallTo = Join-Path $env:ProgramFiles 'VEXO Print Agent'
$StateDir  = Join-Path $env:ProgramData 'VexoPrintAgent'
$SourceDir = Split-Path -Parent $PSScriptRoot   # the agent/ directory

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

function Assert-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell: the task runs as SYSTEM and the state directory is locked to SYSTEM and Administrators.'
  }
}

function Resolve-Node {
  $node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
  if (-not $node) { throw 'node was not found on PATH. Install Node 20.11 or newer (the LTS MSI) and re-run.' }
  # engines in package.json says >=20.11, and the agent uses fetch, so an older
  # Node fails at the first heartbeat rather than at install time. Catch it here.
  $v = (& $node --version).TrimStart('v')
  $parts = $v.Split('.')
  $major = [int]$parts[0]; $minor = [int]$parts[1]
  if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 11)) {
    throw "node $v is too old; the agent needs 20.11 or newer (global fetch and node:test)."
  }
  Write-Host "  node $v at $node"
  return $node
}

# Only SYSTEM and Administrators. The credential file is written 0600-equivalent
# by the agent itself, but on Windows an inherited ACL from ProgramData grants
# Users read, so the directory ACL is what actually protects the secret —
# `doctor` reports the credential's mode out loud for exactly this reason.
function Lock-StateDir($dir) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $acl = Get-Acl $dir
  $acl.SetAccessRuleProtection($true, $false)   # stop inheriting from ProgramData
  foreach ($who in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      $who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  Set-Acl -Path $dir -AclObject $acl
  Write-Host "  $dir — SYSTEM and Administrators only"
}

function Copy-Agent {
  New-Item -ItemType Directory -Path $InstallTo -Force | Out-Null
  foreach ($item in @('src', 'install', 'package.json', 'README.md')) {
    $from = Join-Path $SourceDir $item
    if (Test-Path $from) {
      Copy-Item -Path $from -Destination $InstallTo -Recurse -Force
    }
  }
  # What is installed, tied to what it was built from. `status` prints this back,
  # so a support call can establish which bytes are running without a filesystem
  # tour of the till.
  $pkg = Get-Content (Join-Path $SourceDir 'package.json') -Raw | ConvertFrom-Json
  $manifest = [ordered]@{
    installedAt   = (Get-Date).ToString('o')
    agentVersion  = $pkg.version
    installedFrom = $SourceDir
    installedBy   = "$env:USERDOMAIN\$env:USERNAME"
    hostname      = $env:COMPUTERNAME
    nodeVersion   = (& node --version)
  }
  $manifest | ConvertTo-Json | Set-Content -Path (Join-Path $InstallTo 'install-manifest.json') -Encoding utf8
  Write-Host "  agent $($pkg.version) in $InstallTo"
}

function Register-Task($node) {
  $cli = Join-Path $InstallTo 'src\cli.js'
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`" run" -WorkingDirectory $InstallTo
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  # RestartInterval matches the systemd unit's RestartSec: slow enough that a
  # crash loop is legible in the task history instead of scrolling past.
  # ExecutionTimeLimit 0 means "never kill it" — this is a daemon.
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartInterval (New-TimeSpan -Seconds 60) -RestartCount 999 `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "  scheduled task '$TaskName' registered, runs as SYSTEM at startup"
}

if ($Uninstall) {
  Assert-Elevated
  Write-Step 'Stopping and removing the scheduled task'
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  } else { Write-Warn "no task named '$TaskName'" }

  Write-Step 'Removing the program files'
  if (Test-Path $InstallTo) { Remove-Item -Path $InstallTo -Recurse -Force }

  if ($Purge) {
    Write-Step 'Purging the credential, config and journal'
    # The agent's own uninstall revokes nothing server-side — a manager revokes
    # the agent in the console, which is the record that matters. This only
    # removes what is on the till.
    $cli = Join-Path $InstallTo 'src\cli.js'
    if (Test-Path $cli) { & node $cli uninstall --purge --yes }
    if (Test-Path $StateDir) { Remove-Item -Path $StateDir -Recurse -Force }
    Write-Warn 'Revoke this agent in the VEXO console as well — removing the till does not revoke its credential.'
  } else {
    Write-Warn "State kept at $StateDir (credential, config, journal). Re-run with -Purge to remove it."
    Write-Warn 'An unfinished entry in that journal is the only local record that bytes were in flight.'
  }
  Write-Host 'Removed.' -ForegroundColor Green
  return
}

if ($Update) {
  Assert-Elevated
  $node = Resolve-Node
  Write-Step 'Stopping the agent'
  # SIGTERM-equivalent: the task is stopped, the runner finishes the job it is
  # writing. Nothing is claimed while it is down; the queue holds.
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }
  Write-Step 'Replacing the program files (state and credential untouched)'
  Copy-Agent
  Register-Task $node
  Write-Step 'Starting'
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  & $node (Join-Path $InstallTo 'src\cli.js') doctor
  return
}

# --- install ----------------------------------------------------------------

Assert-Elevated
if (-not $Server)    { throw 'A -Server URL is required, e.g. -Server https://pos.example.com' }
if (-not $EnrolCode) { throw 'An -EnrolCode is required. A manager creates the agent in the VEXO console and the code is shown once.' }

$node = Resolve-Node
Write-Step 'Locking the state directory'
Lock-StateDir $StateDir
Write-Step 'Copying the agent'
Copy-Agent

$cli = Join-Path $InstallTo 'src\cli.js'

Write-Step 'Enrolling this till'
# Enrolment happens BEFORE the task is registered. A till that is running and
# not enrolled reports healthy in Task Scheduler and prints nothing.
& $node $cli enrol $EnrolCode --server $Server
if ($LASTEXITCODE -ne 0) { throw "enrolment failed (exit $LASTEXITCODE). The code works exactly once — issue a new one in the console." }

if ($PrinterHost) {
  Write-Step 'Recording the local printer for diagnostics and drawer commands'
  # Print jobs carry their own target from the server. This is for `selftest`,
  # `doctor`, and as the last-resort route for a drawer command, which arrives
  # with a pin and two durations but no address.
  & $node $cli config set "printerTransport=$Transport" "printerHost=$PrinterHost" "printerPort=$PrinterPort"
}

Write-Step 'Registering the startup task'
Register-Task $node

Write-Step 'Starting the agent'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

Write-Step 'Diagnostics'
& $node $cli doctor
$doctorExit = $LASTEXITCODE

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host "  state     $StateDir"
Write-Host "  log       $(Join-Path $StateDir 'agent.log')"
Write-Host "  task      $TaskName (Task Scheduler → Task Scheduler Library)"
Write-Host ''
Write-Host 'Next, and it is not optional:' -ForegroundColor Yellow
Write-Host "  node `"$cli`" selftest"
Write-Host '  Read the character ruler off the paper. The number of the last visible'
Write-Host '  column is this roll''s width. Set PrintTarget.widthChars in the console to'
Write-Host '  it. Characters-per-line from a browser print does not measure this: that'
Write-Host '  path rasterises through the driver, so its line length is a CSS property.'
if ($doctorExit -ne 0) {
  Write-Warn "doctor exited $doctorExit — at least one check failed above. Fix it before the store opens."
  exit $doctorExit
}
