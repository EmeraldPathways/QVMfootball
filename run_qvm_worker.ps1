param(
    [switch]$Once,
    [int]$Interval = 0
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot
$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    throw "The virtual environment is missing. Run .\install_windows.ps1 first."
}

$WorkerArgs = @()
if ($Once) { $WorkerArgs += "--once" }
if ($Interval -gt 0) { $WorkerArgs += @("--interval", [string]$Interval) }
& $Python (Join-Path $ProjectRoot "worker_service.py") @WorkerArgs
exit $LASTEXITCODE
