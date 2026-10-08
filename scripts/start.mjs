import { spawn } from 'node:child_process'
const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/start-windows.ps1'],{stdio:'inherit',windowsHide:true})
child.on('exit',code=>{process.exitCode=code || 0})
child.on('error',e=>{console.error(e.message);process.exitCode=1})
