@echo off
set "QVM_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%QVM_ROOT%run_qvm_worker.ps1" %*
