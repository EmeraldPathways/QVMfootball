param([int]$Port = 8000)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot
$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    throw "The virtual environment is missing. Run .\install_windows.ps1 first."
}
& $Python -m uvicorn main:app --host 127.0.0.1 --port $Port
