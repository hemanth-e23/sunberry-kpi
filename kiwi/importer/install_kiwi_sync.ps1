# install_kiwi_sync.ps1 -- run kiwi_sync.py every 5 minutes on this PC.
#
# Run once, in PowerShell, as the Windows user whose OneDrive syncs the
# SharePoint shift report folder (no admin needed):
#     powershell -ExecutionPolicy Bypass -File install_kiwi_sync.ps1
# Remove later with:
#     Unregister-ScheduledTask -TaskName "KIWI shift report sync" -Confirm:$false
#
# It also locks kiwi_sync.conf so only this Windows account can read it (it holds the token).

$ErrorActionPreference = "Stop"
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here "kiwi_sync.py"
$conf   = Join-Path $here "kiwi_sync.conf"

$python = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command python.exe -ErrorAction Stop).Source }
if (-not (Test-Path $conf)) { throw "Create kiwi_sync.conf next to this script first (see kiwi_sync.py)." }

# Only this user (and SYSTEM) may read the token file.
icacls $conf /inheritance:r /grant:r "$($env:USERNAME):(R,W)" "SYSTEM:(F)" | Out-Null

# Check it works before scheduling it.
& $python $script --dry-run
if ($LASTEXITCODE -ne 0) { throw "Dry run failed - see kiwi_sync.log" }

$action   = New-ScheduledTaskAction -Execute $python -Argument "`"$script`"" -WorkingDirectory $here
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
              -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
              -MultipleInstances IgnoreNew -StartWhenAvailable -DontStopIfGoingOnBatteries
# Runs as you, only while you're signed in -- the same time OneDrive is syncing.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName "KIWI shift report sync" -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Installed: KIWI shift report sync runs every 5 minutes. Log: $here\kiwi_sync.log"
