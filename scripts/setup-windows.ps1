$ErrorActionPreference = 'Stop'
$jarvisRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $jarvisRoot
$env:npm_config_cache=Join-Path $jarvisRoot '.local\npm-cache'
& npm.cmd ci --ignore-scripts --no-audit --no-fund
if($LASTEXITCODE -ne 0){throw 'Dependency install failed. Check internet access and retry.'}
# Vite's native configuration loader avoids unnecessary dependency lifecycle hooks.
& npm.cmd run build
if($LASTEXITCODE -ne 0){throw 'Build failed. See the error above.'}
$ollamaExe=Join-Path $jarvisRoot 'runtime\ollama\ollama.exe'
if(-not(Test-Path -LiteralPath $ollamaExe)){throw 'Portable Ollama runtime is missing. Follow README-WINDOWS.md installation steps.'}
& (Join-Path $PSScriptRoot 'start-windows.ps1') -NoBrowser
$env:OLLAMA_HOST='127.0.0.1:11434'
Write-Output 'Downloading/resuming qwen3:4b from the official Ollama registry (about 2.5 GB). No paid provider is used.'
$downloadBusy = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'download-model\.py' }
if ($downloadBusy) {
    Write-Output 'A qwen3:4b download is already running. Not starting another.'
} elseif (Get-Command python.exe -ErrorAction SilentlyContinue) {
    $env:JARVIS_DOWNLOAD_WORKERS = '8'
    & python.exe (Join-Path $PSScriptRoot 'download-model.py')
} else {
    & $ollamaExe pull qwen3:4b
}
if($LASTEXITCODE -ne 0){throw 'Model download failed. Run Setup-Jarvis.cmd again to resume.'}
Write-Output 'Setup completed. Start-Jarvis.cmd opens ICE.'
