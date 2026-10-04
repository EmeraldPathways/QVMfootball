$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$PythonLauncher = Get-Command py -ErrorAction SilentlyContinue
if (-not $PythonLauncher) {
    throw "Python launcher 'py' was not found. Install Python 3.11 or newer from python.org and retry."
}

$PythonVersion = $null
foreach ($Candidate in @("3.13", "3.12", "3.11")) {
    & py -$Candidate --version *> $null
    if ($LASTEXITCODE -eq 0) {
        $PythonVersion = $Candidate
        break
    }
}
if (-not $PythonVersion) {
    throw "Python 3.11, 3.12, or 3.13 was not found through the Windows launcher."
}

Write-Host "Using Python $PythonVersion."
& py -$PythonVersion -m venv (Join-Path $ProjectRoot ".venv")
$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    throw "Python 3.11 was not found through the Windows launcher."
}
& $Python -m pip install --upgrade pip
& $Python -m pip install -r (Join-Path $ProjectRoot "requirements.txt")

if (-not (Test-Path (Join-Path $ProjectRoot ".env"))) {
    Copy-Item (Join-Path $ProjectRoot ".env.windows.example") (Join-Path $ProjectRoot ".env")
    Write-Host "Created .env from .env.windows.example. Add private API keys before running the worker."
}

Write-Host "QVM Windows environment is ready. Run .\run_qvm_worker.ps1 -Once for a smoke cycle."
