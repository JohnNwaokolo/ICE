import { existsSync } from 'node:fs'
console.log('ICE: local runtime preflight')
console.log('Node:',process.versions.node,'(24+ required)')
for(const p of ['runtime/ollama/ollama.exe','runtime/whisper/Release/whisper-cli.exe','runtime/whisper/ggml-tiny.bin','runtime/whisper/ggml-tiny.en.bin','dist/index.html'])console.log(existsSync(p)?'OK':'MISSING',p)
try {const r=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(3000)});const data=await r.json();console.log('Ollama models:',data.models?.map(m=>m.name).join(', ') || '(none)')} catch {console.log('Ollama not running. Use Start-Jarvis.cmd.')}
console.log('No Claude login or paid API key is needed. Setup-Jarvis.cmd downloads the local model.')
