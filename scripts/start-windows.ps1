param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$jarvisRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $jarvisRoot
$localDirectory = Join-Path $jarvisRoot '.local'
$logsDirectory = Join-Path $localDirectory 'logs'
New-Item -ItemType Directory -Force -Path $localDirectory,$logsDirectory | Out-Null
$env:NO_PROXY = '127.0.0.1,localhost'
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeVersion = & $nodeCommand.Source -p 'parseInt(process.versions.node)'
if ([int]$nodeVersion -lt 24) { throw 'Node.js 24 or newer is required. Install from https://nodejs.org/.' }
if (-not (Test-Path -LiteralPath (Join-Path $jarvisRoot 'dist\index.html'))) { throw 'The interface has not been built. Run Setup-Jarvis.cmd first.' }
if (-not (Test-Path -LiteralPath (Join-Path $jarvisRoot 'node_modules\ws\package.json'))) { throw 'Dependencies are missing. Run Setup-Jarvis.cmd first.' }
# This script starts only local Ollama by default; provider settings live in backend.env.
$nodeArgs = @('--env-file-if-exists=backend.env', 'bridge/server.mjs')
$ollamaExe = Join-Path $jarvisRoot 'runtime\ollama\ollama.exe'
$ollamaReady = $false
try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2; $ollamaReady = $true } catch {}
if (-not $ollamaReady -and (Test-Path -LiteralPath $ollamaExe)) {
    $env:OLLAMA_HOST = '127.0.0.1:11434'
    $env:OLLAMA_NO_CLOUD = '1'
    $env:OLLAMA_MODELS = Join-Path $jarvisRoot 'runtime\ollama\models'
    $env:OLLAMA_CONTEXT_LENGTH = '2048'
    $env:OLLAMA_NUM_PARALLEL = '1'
    $env:OLLAMA_MAX_LOADED_MODELS = '1'
    $env:OLLAMA_KEEP_ALIVE = '2m'
    $env:OLLAMA_NUM_GPU = '0'
    $originalProfile = $env:USERPROFILE
    $env:USERPROFILE = Join-Path $jarvisRoot 'runtime\ollama\profile'
    New-Item -ItemType Directory -Force -Path $env:USERPROFILE,$env:OLLAMA_MODELS | Out-Null
    try {
        $ollamaProcess = Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WorkingDirectory (Split-Path $ollamaExe) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logsDirectory 'ollama.log') -RedirectStandardError (Join-Path $logsDirectory 'ollama-error.log')
        @{pid=$ollamaProcess.Id; startTime=$ollamaProcess.StartTime.ToUniversalTime().ToString('o'); path=$ollamaExe} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $localDirectory 'ollama-process.json')
    } finally { $env:USERPROFILE = $originalProfile }
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        try { $null=Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2; $ollamaReady=$true; break } catch {}
        if ($ollamaProcess.HasExited) { break }
    }
}
if (-not $ollamaReady) { Write-Warning 'Ollama is unavailable. Local time and memory work; run Setup-Jarvis.cmd to enable conversation.' }
else {
    try { $models=Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3; if (-not ($models.models.name -contains 'qwen3:4b')) { Write-Warning 'qwen3:4b is not downloaded yet. Run Setup-Jarvis.cmd; ICE will show a clear model error meanwhile.' } } catch {}
}
$sessionPath=Join-Path $localDirectory 'session.json'
$bridgeReady=$false
try { $health=Invoke-RestMethod 'http://127.0.0.1:8787/health' -TimeoutSec 2; if ($health.service -ne 'jarvis-john') { throw 'Port 8787 belongs to another app.' }; $bridgeReady=$true } catch {}
if (-not $bridgeReady) {
    $bridgeProcess=Start-Process -FilePath $nodeCommand.Source -ArgumentList $nodeArgs -WorkingDirectory $jarvisRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logsDirectory 'bridge.log') -RedirectStandardError (Join-Path $logsDirectory 'bridge-error.log')
    for ($i=0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if ($bridgeProcess.HasExited) { throw "ICE exited. Read $logsDirectory\bridge-error.log" }
        try { $health=Invoke-RestMethod 'http://127.0.0.1:8787/health' -TimeoutSec 1; if($health.service -eq 'jarvis-john' -and $health.pid -eq $bridgeProcess.Id){$bridgeReady=$true;break} } catch {}
    }
}
if (-not $bridgeReady -or -not (Test-Path -LiteralPath $sessionPath)) { throw 'The bridge did not start. Check .local/logs/bridge-error.log.' }
$session=Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
if ($health.pid -ne $session.pid) { throw 'Another ICE installation owns port 8787. Stop that installation first.' }
if (-not $NoBrowser) { Start-Process -FilePath $session.url }
Write-Output 'ICE is running at http://127.0.0.1:8787. Use Start-Jarvis.cmd to open an authenticated session. Stop-Jarvis.cmd stops this installation.'
