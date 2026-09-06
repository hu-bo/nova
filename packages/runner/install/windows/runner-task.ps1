param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Uninstall")]
  [string]$Mode,

  [string]$Executable,
  [string]$Config
)

$ErrorActionPreference = "Stop"
$taskName = "Nova Runner"

if ($Mode -eq "Uninstall") {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Nova Runner executable was not installed: $Executable"
}
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
  throw "Nova Runner configuration was not created: $Config"
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$escapedExecutable = $Executable.Replace("'", "''")
$escapedConfig = $Config.Replace("'", "''")
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"& '$escapedExecutable' --config '$escapedConfig'; exit `$LASTEXITCODE`""
$action = New-ScheduledTaskAction -Execute "$PSHOME\powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
