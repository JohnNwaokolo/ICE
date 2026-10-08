$ErrorActionPreference = 'Stop'
$jarvisRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sessionPath=Join-Path $jarvisRoot '.local\session.json'
if (Test-Path -LiteralPath $sessionPath) {
    $session=Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
    try {
        $health=Invoke-RestMethod -Uri "http://127.0.0.1:$($session.port)/health" -TimeoutSec 2
        if($health.service -ne 'jarvis-john' -or $health.pid -ne $session.pid){throw 'The recorded bridge does not match the running service. No process was stopped.'}
        $null=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($session.port)/api/shutdown" -Headers @{Authorization="Bearer $($session.token)"} -TimeoutSec 5
        Write-Output 'ICE bridge stopped.'
    } catch { Write-Warning "Bridge stop: $($_.Exception.Message)" }
} else { Write-Output 'ICE bridge is not running.' }
$recordPath=Join-Path $jarvisRoot '.local\ollama-process.json'
if(Test-Path -LiteralPath $recordPath){
    $record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if($process -and $process.Path -eq $record.path -and $process.StartTime.ToUniversalTime().Ticks -eq ([datetime]$record.startTime).ToUniversalTime().Ticks){
        Stop-Process -Id $record.pid
        Remove-Item -LiteralPath $recordPath
        Write-Output 'The Ollama process started by this ICE installation was stopped.'
    }
}
