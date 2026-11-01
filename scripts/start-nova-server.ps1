param(
    [ValidateSet('dev', 'dev:worker', 'start', 'start:worker')]
    [string]$Mode = 'dev'
)

$ErrorActionPreference = 'Stop'

# Configure the parent shell before pnpm starts; changing chcp inside Node is too late
# for PowerShell pipelines that have already selected their native-output decoder.
$utf8Encoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8Encoding
[Console]::OutputEncoding = $utf8Encoding
$OutputEncoding = $utf8Encoding

$serverDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/nova-server'
$pnpmCommand = Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
& $pnpmCommand.Source --dir $serverDirectory $Mode
exit $LASTEXITCODE
