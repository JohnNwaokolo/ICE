// ICE (John) local bridge. Original Jarvis project copyright/terms: ../LICENSE.
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto'
import { writeFileSync, existsSync, mkdirSync, rmSync, statSync, realpathSync, openSync, closeSync, readdirSync } from 'node:fs'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname, resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { providerConfig, completion, geminiAuthFailed, ollamaFallbackConfig, redactSecrets, persistGeminiModel, geminiModelOrder, geminiBusy, transcribeAudioGemini, alternateBrains, geminiShouldFailover } from './local/provider.mjs'
import { openStore } from './local/storage.mjs'
import { createTools, currentTime } from './local/tools.mjs'
import { runAgent } from './local/agent.mjs'
import { pcm16Mono16k, canonicalPcm16Wav, padPcm16Silence, whisperLanguageForClip } from './local/wav-pcm.mjs'

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const LOCAL=join(ROOT,'.local'), DATA=process.env.JARVIS_DATA_DIR || join(ROOT,'data')
mkdirSync(LOCAL,{recursive:true}); mkdirSync(DATA,{recursive:true})
const PORT=Number(process.env.JARVIS_PORT || 8787), ORIGIN=`http://127.0.0.1:${PORT}`
const TOKEN=randomBytes(32).toString('hex')
let config=providerConfig(process.env,{localDir:LOCAL})
const store=openStore(join(DATA,'jarvis.sqlite'))
let serving={provider:config.provider,model:config.model}
let notice=''
let geminiTts=false
let geminiTtsModel=''
function rememberGemini(model) {
  if (!model) return
  config={...config,provider:'gemini',model}
  serving={provider:'gemini',model}
  notice=''
  persistGeminiModel(model,{localDir:LOCAL,envPath:join(ROOT,'backend.env')})
  process.env.GEMINI_MODEL=model
}
const sessionFile=join(LOCAL,'session.json')
const tokenEqual=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value),Buffer.from(TOKEN))
function authenticated(req) {
  const bearer=req.headers.authorization?.replace(/^Bearer /,'')
  const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('jarvis_session='))?.slice(15)
  return tokenEqual(bearer) || tokenEqual(cookie)
}
const validClient=req=>req.headers.host===`127.0.0.1:${PORT}` && (!req.headers.origin || req.headers.origin===ORIGIN)
function reply(res,status,data) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
  res.end(JSON.stringify(data))
}
async function body(req,limit=64000) {
  const chunks=[];let size=0
  for await(const c of req) { size+=c.length;if(size>limit) throw Object.assign(new Error('Request is too large.'),{status:413});chunks.push(c) }
  return Buffer.concat(chunks)
}
async function json(req) { const raw=await body(req);try{return JSON.parse(raw.toString() || '{}')}catch{throw new Error('Request must be valid JSON.')} }
const settings=createTools({store,root:ROOT,confirm:async()=>false})
const whisperDir=join(ROOT,'runtime','whisper')
const findWhisper=()=>[join(whisperDir,'whisper-cli.exe'),join(whisperDir,'Release','whisper-cli.exe'),join(whisperDir,'bin','whisper-cli.exe')].find(existsSync)
const TINY_MODEL={file:'ggml-tiny.bin',size:77691713,label:'whisper.cpp ggml-tiny.bin multilingual'}
function pickWhisperModel() {
  const tiny=join(whisperDir,TINY_MODEL.file)
  const englishOnly=join(whisperDir,'ggml-tiny.en.bin')
  if (existsSync(tiny) && statSync(tiny).size===TINY_MODEL.size) return {path:tiny,...TINY_MODEL}
  if (existsSync(tiny) && statSync(tiny).size>50_000_000 && !tiny.toLowerCase().endsWith('tiny.en.bin')) return {path:tiny,...TINY_MODEL}
  if (existsSync(englishOnly)) return null
}
async function checkpointPercent() {
  let percent, total, status
  try {
    const p=JSON.parse(await readFile(join(ROOT,'runtime','ollama','pull-progress.json'),'utf8'))
    status=p.status
    if (p.status==='success') return {percent:100,status}
    if (Number.isFinite(p.total) && p.total>0) total=p.total
    if (Number.isFinite(p.percent)) percent=p.percent
    if (Number.isFinite(p.completed) && total) {
      const live=Math.floor(p.completed*100/total)
      percent=Math.max(percent??0, p.completed>=total ? 100 : Math.min(99, live))
    }
  } catch {}
  try {
    const partsRoot=join(ROOT,'runtime','ollama','models','download-parts')
    if (existsSync(partsRoot) && total) {
      let bytes=0
      for (const digest of readdirSync(partsRoot)) {
        const dir=join(partsRoot,digest)
        if (!statSync(dir).isDirectory()) continue
        for (const name of readdirSync(dir)) {
          if (name.endsWith('.part') || name.endsWith('.tmp')) bytes+=statSync(join(dir,name)).size
        }
      }
      percent=Math.max(percent??0, bytes>=total ? 100 : Math.min(99, Math.floor(bytes*100/total)))
    }
  } catch {}
  return {percent,status}
}
async function health() {
  let ollama=false,ollamaService=false,downloadPercent,error
  if(serving.provider==='ollama') {
    const local=config.provider==='ollama'?config:ollamaFallbackConfig()
    try { const r=await fetch(`${local.base}/api/tags`,{signal:AbortSignal.timeout(4000)});const j=await r.json();ollamaService=r.ok;ollama=Boolean(j.models?.some(m=>m.name===local.model || m.name===local.model+':latest'));if(!ollama)error='qwen3:4b is missing. Run Setup-Jarvis.cmd.' }
    catch {error='Ollama is not running. Run Start-Jarvis.cmd.'}
  }
  if(ollamaService && !ollama) {
    const progress=await checkpointPercent()
    downloadPercent=progress.percent
    if (progress.status==='success') error='qwen3:4b is downloaded. If this message remains, run Stop-Jarvis.cmd then Start-Jarvis.cmd.'
    else if (progress.percent>=100) error='qwen3:4b checkpoints complete. Verifying the official SHA256 and installing the model…'
    else if (Number.isFinite(progress.percent)) error=`qwen3:4b download checkpoint: ${progress.percent}%. Keep setup running, or run Setup-Jarvis.cmd to resume.`
  }
  return {ok:true,provider:serving.provider,model:serving.model,brain:`${serving.provider === 'gemini' ? 'Gemini' : serving.provider === 'groq' ? 'Groq' : serving.provider === 'xai' ? 'Grok' : serving.provider} ${serving.model}`,alternates:{groq:Boolean(String(process.env.GROQ_API_KEY||'').trim()),xai:Boolean(String(process.env.XAI_API_KEY||process.env.GROK_API_KEY||'').trim())},ollama,ollamaService,downloadPercent,stt:Boolean(findWhisper() && pickWhisperModel()),sttEngine:pickWhisperModel()?.label || null,ttsEngine:geminiTts?'gemini':'system',geminiTts,timezone:'Africa/Lagos',...(error?{error}:{}),...(notice?{notice}:{}),cloudMemoryShared:process.env.JARVIS_SHARE_MEMORY==='1'}
}
let transcribing=false
const clearSessions=new Set()
async function transcribe(req,res) {
  const model=pickWhisperModel()
  if(!findWhisper() || !model) throw new Error('Local speech files are not ready. Run Setup-Jarvis.cmd; typed chat remains available.')
  if(transcribing) throw new Error('A recording is already being transcribed. Wait or cancel it first.')
  const wav=await body(req,2_100_000)
  const pcm=pcm16Mono16k(wav)
  if(!pcm) throw new Error('Recording must be mono 16 kHz PCM16 WAV, at most 60 seconds.')
  if(pcm.length>1_920_000) throw new Error('Recording exceeded 60 seconds. Please try a shorter message.')
  let energy=0
  for(let i=0;i+1<pcm.length;i+=2)energy+=(pcm.readInt16LE(i)/32768)**2
  if(Math.sqrt(energy/Math.max(1,pcm.length/2))<0.001)throw new Error('The recording is silent or too quiet. Check your microphone and try again.')
  if(transcribing)throw new Error('A recording is already being transcribed. Please wait.')
  transcribing=true
  let folder
  const abort=new AbortController(),started=Date.now()
  const disconnect=()=>{if(!res.writableEnded)abort.abort()};res.on('close',disconnect)
  try {
    folder=await mkdtemp(join(tmpdir(),'jarvis-speech-'))
    const input=join(folder,'input.wav'),output=join(folder,'transcript')
    writeFileSync(input,canonicalPcm16Wav(padPcm16Silence(pcm)))
    if(config.provider==='gemini') {
      try {
        const heard=await transcribeAudioGemini(config,canonicalPcm16Wav(padPcm16Silence(pcm)),abort.signal)
        if(heard?.text) return reply(res,200,{text:heard.text,elapsedMs:Date.now()-started,engine:heard.engine})
      } catch(e) {
        if(e.code==='GEMINI_AUTH' || abort.signal.aborted) throw e
      }
    }
    const runWhisper=lang=>new Promise((yes,no)=>{
      const log=openSync(join(folder,'whisper.log'),'w')
      let child
      const args=['-m',model.path,'-f',input,'-l',lang,'-t','4','-bs','3','-bo','1','-nt','-np','-otxt','-of',output]
      try {child=spawn(findWhisper(),args,{shell:false,windowsHide:true,stdio:['ignore',log,log],signal:abort.signal})}
      finally {closeSync(log)}
      const timer=setTimeout(()=>{child.kill();no(new Error('Speech transcription timed out. Try a shorter recording.'))},45000)
      child.on('error',e=>{clearTimeout(timer);no(e)})
      child.on('exit',code=>{clearTimeout(timer);if(code===0)yes();else no(new Error(`Whisper exited with code ${code}. Check its runtime files and model.`))})
    })
    const firstLang=whisperLanguageForClip(pcm)
    await runWhisper(firstLang)
    let text=(await readFile(`${output}.txt`,'utf8').catch(()=> '')).trim()
    if (!text || /^\[.*\]$/.test(text)) {
      const alt=firstLang==='en'?'auto':'en'
      await runWhisper(alt)
      text=(await readFile(`${output}.txt`,'utf8').catch(()=> '')).trim()
    }
    if(!text || /^\[.*\]$/.test(text)) throw new Error('No clear speech was detected. Try again closer to the microphone.')
    reply(res,200,{text,elapsedMs:Date.now()-started,engine:model.label})
  } finally {transcribing=false;res.off('close',disconnect);if(folder)await rm(folder,{recursive:true,force:true})}
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.wasm':'application/wasm','.mp3':'audio/mpeg'}
const server=http.createServer(async(req,res)=>{
  try {
    if(!validClient(req)) return reply(res,403,{error:'Untrusted host or origin.'})
    const url=new URL(req.url,ORIGIN),path=url.pathname
    if(req.method==='GET' && path==='/health') return reply(res,200,{ok:true,service:'jarvis-john',pid:process.pid})
    if(path==='/api/session' && req.method==='POST') {
      if(!tokenEqual(req.headers.authorization?.replace(/^Bearer /,''))) return reply(res,401,{error:'Open ICE using Start-Jarvis.cmd to authorize this browser.'})
      res.setHeader('Set-Cookie',`jarvis_session=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`)
      return reply(res,200,{ok:true})
    }
    if(path.startsWith('/api/')) {
      if(!authenticated(req)) return reply(res,401,{error:'Session expired. Open ICE with Start-Jarvis.cmd.'})
      if(!['GET','HEAD'].includes(req.method) && req.headers.origin!==ORIGIN && !tokenEqual(req.headers.authorization?.replace(/^Bearer /,''))) return reply(res,403,{error:'State changes require the ICE origin.'})
      if(req.method==='GET' && path==='/api/health') return reply(res,200,await health())
      if(req.method==='GET' && path==='/api/time') return reply(res,200,currentTime())
      if(req.method==='GET' && path==='/api/profile') return reply(res,200,store.profile())
      if(req.method==='PUT' && path==='/api/profile') return reply(res,200,store.saveProfile(await json(req)))
      if(req.method==='GET' && path==='/api/records') return reply(res,200,store.list())
      if(req.method==='POST' && path==='/api/records') return reply(res,201,store.save(await json(req)))
      const match=/^\/api\/records\/(\d+)$/.exec(path)
      if(match && req.method==='PUT') return reply(res,200,store.save(await json(req),Number(match[1])))
      if(match && req.method==='DELETE') { const b=await json(req);if(b.confirm!==true) return reply(res,409,{error:'Confirm the exact record deletion first.'});store.remove(Number(match[1]));return reply(res,200,{ok:true}) }
      if(path==='/api/history' && req.method==='GET') return reply(res,200,store.history())
      if(path==='/api/history' && req.method==='DELETE') {const b=await json(req);if(b.confirm!==true)return reply(res,409,{error:'Confirm clearing conversation history first.'});for(const clear of clearSessions)clear();store.clearHistory();return reply(res,200,{ok:true})}
      if(path==='/api/export' && req.method==='GET') {res.setHeader('Content-Disposition','attachment; filename="ice-memory.json"');return reply(res,200,store.export())}
      if(path==='/api/approvals' && req.method==='GET') return reply(res,200,settings.approvals())
      if(path==='/api/approvals' && req.method==='PUT') return reply(res,200,settings.saveApprovals(await json(req)))
      if(path==='/api/transcribe' && req.method==='POST') return await transcribe(req,res)
      if(path==='/api/shutdown' && req.method==='POST') {reply(res,200,{ok:true});setTimeout(shutdown,100);return}
      return reply(res,404,{error:'That local feature is unavailable. Sending, publishing and account changes are disabled.'})
    }
    if(req.method!=='GET') return reply(res,405,{error:'Method not allowed.'})
    const dist=join(ROOT,'dist'),file=resolve(dist,`.${decodeURIComponent(path==='/'?'/index.html':path)}`),rel=relative(dist,file)
    if(rel.startsWith('..') || !existsSync(file) || !statSync(file).isFile() || relative(dist,realpathSync(file)).startsWith('..')) return reply(res,404,{error:'Page not found. If the interface is missing, run npm run build.'})
    res.writeHead(200,{'Content-Type':MIME[extname(file)] || 'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'microphone=(self), camera=(self), geolocation=()'})
    res.end(await readFile(file))
  } catch(e) {if(!res.headersSent && !res.destroyed)reply(res,e.status||400,{error:e.message || 'Request failed.'})}
})
server.requestTimeout=150000
const wss=new WebSocketServer({noServer:true,maxPayload:64000})
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/ws' || !validClient(req) || !authenticated(req) || (req.headers.origin!==ORIGIN && !tokenEqual(req.headers.authorization?.replace(/^Bearer /,'')))) {socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req))
})
let globalBusy=null
wss.on('connection',ws=>{
  let history=[], active=null
  const pending=new Map(),send=m=>{if(ws.readyState===1)ws.send(JSON.stringify(m))}
  const interrupt=()=>{active?.abort();for(const p of pending.values())p(false);pending.clear()}
  const clear=()=>{interrupt();history=[];send({type:'history_cleared'})}
  clearSessions.add(clear)
  const confirm=(preview,signal)=>new Promise(resolveConfirm=>{
    const id=randomUUID(),timer=setTimeout(()=>finish(false),120000)
    const finish=value=>{clearTimeout(timer);pending.delete(id);signal.removeEventListener('abort',cancel);resolveConfirm(value)}
    const cancel=()=>finish(false)
    pending.set(id,finish);signal.addEventListener('abort',cancel,{once:true})
    send({type:'confirm',id,preview,ask:active?.ask})
  })
  const tools=createTools({store,root:ROOT,confirm})
  send({type:'ready',servers:[serving.provider==='gemini'?`Gemini ${serving.model}`:`Ollama ${serving.model}`,'Africa/Lagos clock','Local SQLite memory','Approved tools']})
  ws.on('message',async raw=>{
    let frame
    try{frame=JSON.parse(raw)}catch{send({type:'error',message:'Invalid message JSON.'});return}
    if(!frame || typeof frame!=='object' || Array.isArray(frame)){send({type:'error',message:'Message must be an object.'});return}
    if(frame.type==='interrupt'){interrupt();return}
    if(frame.type==='confirm_result'){pending.get(frame.id)?.(frame.approved===true);return}
    if(frame.type!=='ask')return
    const id=frame.id
    if(typeof id!=='string' || id.length>100 || typeof frame.text!=='string' || !frame.text.trim() || frame.text.length>12000){send({type:'error',ask:id,message:'Message must contain 1–12,000 characters.'});return}
    interrupt()
    if(globalBusy && globalBusy!==ws){send({type:'error',ask:id,message:'ICE is answering in another window. Stop that turn or wait.'});return}
    const controller=new AbortController();controller.ask=id;active=controller;globalBusy=ws
    const timer=setTimeout(()=>controller.abort(),300000)
    const emit=m=>{if(active===controller && !controller.signal.aborted)send({...m,ask:id})}
    try {
      const result=await runAgent({text:frame.text.trim(),history,store,tools,config,signal:controller.signal,emit,complete:async(cfg,messages,schemas,signal,onText)=>{
        const active=config.provider==='gemini'?config:cfg
        try {
          const out=await completion(active,messages,schemas,signal,onText)
          if(active.provider==='gemini') rememberGemini(out.model || active.model)
          else serving={provider:active.provider,model:out.model || active.model}
          return out
        } catch(e) {
          if(active.provider==='gemini' && geminiShouldFailover(e)) {
            for (const brain of alternateBrains()) {
              try {
                serving={provider:brain.provider,model:brain.model}
                notice=`Gemini failed, using ${brain.label}`
                emit({type:'status',message:notice,provider:serving.provider,model:serving.model})
                const out=await completion(brain,messages,schemas,signal,onText)
                serving={provider:brain.provider,model:out.model || brain.model}
                return out
              } catch (next) {
                if (signal.aborted) throw next
              }
            }
          }
          if(active.provider==='gemini' && (e.code==='GEMINI_BUSY' || e.code==='GEMINI_AUTH')) {
            const local=ollamaFallbackConfig()
            if(e.code==='GEMINI_AUTH') config=local
            serving={provider:'ollama',model:'qwen3:4b'}
            notice=e.code==='GEMINI_BUSY'?'Gemini busy, using local model':'Gemini key rejected, using local model'
            emit({type:'status',message:notice,provider:serving.provider,model:serving.model})
            return await completion(local,messages,schemas,signal,onText)
          }
          throw e
        }
      }})
      if(active!==controller || controller.signal.aborted)return
      history=[...history,...result.messages].slice(-10)
      store.log('user',frame.text.trim());store.log('assistant',result.text)
      emit({type:'done',text:result.text})
    } catch(e) {if(active===controller)send({type:'error',ask:id,message:controller.signal.aborted?'Reply stopped. You can send another message.':e.message})}
    finally {clearTimeout(timer);if(active===controller){active=null;if(globalBusy===ws)globalBusy=null}}
  })
  ws.on('error',()=>{interrupt();ws.close()})
  ws.on('close',()=>{interrupt();clearSessions.delete(clear);if(globalBusy===ws)globalBusy=null})
})
const reminderTimer=setInterval(()=>{
  const clients=[...wss.clients].filter(w=>w.readyState===1)
  if(!clients.length)return
  for(const r of store.due()) {for(const ws of clients)ws.send(JSON.stringify({type:'reminder',id:r.id,text:r.text,due_at:r.due_at}));store.markNotified(r.id)}
},10000)
let stopping=false
function shutdown(){if(stopping)return;stopping=true;clearInterval(reminderTimer);for(const ws of wss.clients)ws.close();server.close();store.close();try{rmSync(sessionFile)}catch{}setTimeout(()=>process.exit(0),200)}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown)
server.on('error',e=>{console.error(`ICE cannot start: ${e.code==='EADDRINUSE'?'port '+PORT+' is already in use. Run Stop-Jarvis.cmd first.':e.message}`);process.exitCode=1;clearInterval(reminderTimer);store.close()})
server.listen(PORT,'127.0.0.1',()=>{
  writeFileSync(sessionFile,JSON.stringify({pid:process.pid,port:PORT,token:TOKEN,url:`${ORIGIN}/#token=${TOKEN}`}),{mode:0o600})
  console.log(`ICE is ready at ${ORIGIN}. Use Start-Jarvis.cmd to open an authenticated browser. Provider: ${serving.provider}; model: ${serving.model}.`)
  if(config.provider==='gemini') {
    void (async()=>{
      const names=geminiModelOrder(config.model)
      const configs=[{maxOutputTokens:8,temperature:0},{maxOutputTokens:8,temperature:0,thinkingConfig:{thinkingBudget:0}}]
      for(const model of names){
        let lastStatus=0, lastText=''
        for(const generationConfig of configs){
          try {
            const r=await fetch(`${config.base}/models/${model}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':config.key},body:JSON.stringify({contents:[{role:'user',parts:[{text:'Reply with ok.'}]}],generationConfig}),signal:AbortSignal.timeout(12000)})
            const text=await r.text().catch(()=>'')
            lastStatus=r.status; lastText=text
            let spoken=''
            try{ spoken=(JSON.parse(text).candidates||[]).flatMap(c=>c.content?.parts||[]).map(p=>p.text||'').join('').trim() }catch{}
            if(r.ok && spoken){rememberGemini(model);console.log('Gemini model ready:',model);return}
            if(geminiAuthFailed(r.status,text)){
              console.error(redactSecrets(`Gemini rejected the API key (HTTP ${r.status}). Local qwen3:4b will be used if it is installed.`))
              try{config=ollamaFallbackConfig();serving={provider:config.provider,model:config.model}}catch{}
              return
            }
            if(r.status===400 && /thinkingConfig|unknown name|Invalid JSON payload|INVALID_ARGUMENT/i.test(text)) continue
            break
          } catch { lastStatus=0 }
        }
        if(lastStatus===404 || geminiBusy(lastStatus,lastText) || lastStatus===429 || lastStatus===400 || !lastStatus) continue
      }
    })()
  }
})
