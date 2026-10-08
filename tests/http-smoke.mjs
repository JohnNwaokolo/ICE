// Run against this installation's live bridge; creates/deletes test-only records.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'
import http from 'node:http'
const session=JSON.parse(readFileSync('.local/session.json','utf8'))
const base=`http://127.0.0.1:${session.port}`, auth={Authorization:`Bearer ${session.token}`}
const results=[]
async function check(name,fn){await fn();results.push({name,passed:true});console.log('PASS',name)}
await check('HTTP rejects unauthenticated data access',async()=>assert.equal((await fetch(base+'/api/profile')).status,401))
await check('HTTP rejects foreign Origin and Host',async()=>{
 assert.equal((await fetch(base+'/api/profile',{headers:{...auth,Origin:'https://evil.example'}})).status,403)
 const status=await new Promise((yes,no)=>{const req=http.get(base+'/api/profile',{headers:{...auth,Host:'evil.example'}},res=>{res.resume();yes(res.statusCode)});req.on('error',no)})
 assert.equal(status,403)
})
await check('Session exchange sets HttpOnly strict cookie',async()=>{
 const r=await fetch(base+'/api/session',{method:'POST',headers:auth});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/)
})
await check('Memory save/update/delete uses explicit confirmation',async()=>{
 const r=await fetch(base+'/api/records',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({kind:'task',text:'Disposable ICE integration test'})})
 const record=await r.json();assert.equal(r.status,201)
 const u=await fetch(base+'/api/records/'+record.id,{method:'PUT',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({done:true})});assert.equal((await u.json()).done,true)
 const denied=await fetch(base+'/api/records/'+record.id,{method:'DELETE',headers:auth});assert.equal(denied.status,409)
 const deleted=await fetch(base+'/api/records/'+record.id,{method:'DELETE',headers:{...auth,'Content-Type':'application/json'},body:'{"confirm":true}'});assert.equal(deleted.status,200)
})
async function rejectedSocket(headers){await new Promise((yes,no)=>{const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers});ws.once('open',()=>{ws.close();no(new Error('Unexpected connection'))});ws.once('error',yes)})}
await check('WebSocket denies no token, foreign Origin and malformed non-ASCII token',async()=>{
 await rejectedSocket({Origin:base});await rejectedSocket({...auth,Origin:'https://evil.example'});await rejectedSocket({Authorization:'Bearer '+'é'.repeat(64)})
 assert.equal((await fetch(base+'/health')).status,200)
})
await check('Authenticated WebSocket handles null frame and returns real clock result',async()=>{
 await new Promise((yes,no)=>{
  const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers:auth});const timer=setTimeout(()=>{ws.close();no(new Error('Clock timeout'))},10000)
  let text='',tool=false
  ws.on('error',no)
  ws.on('open',()=>{ws.send('null');ws.send(JSON.stringify({type:'ask',id:'smoke-clock',text:'What time is it in Lagos?'}))})
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.ask!=='smoke-clock')return;if(m.type==='tool')tool=m.name==='get_time';if(m.type==='text')text+=m.delta;if(m.type==='done'){clearTimeout(timer);ws.close();try{assert.equal(tool,true);assert.match(text,/Africa\/Lagos/);yes()}catch(e){no(e)}}if(m.type==='error'){clearTimeout(timer);ws.close();no(new Error(m.message))}})
 })
})
await check('Speech endpoint rejects malformed WAV',async()=>{
 const r=await fetch(base+'/api/transcribe',{method:'POST',headers:{...auth,'Content-Type':'audio/wav'},body:Buffer.from('not wav')});assert.equal(r.status,400)
})
if(process.argv[2])await check('Actual local Whisper HTTP transcription of reference speech',async()=>{
 const started=Date.now(),r=await fetch(base+'/api/transcribe',{method:'POST',headers:{...auth,'Content-Type':'audio/wav'},body:readFileSync(process.argv[2])}),data=await r.json()
 assert.equal(r.status,200,JSON.stringify(data));assert.match(data.text,/ask not what your country can do for you/i)
 results.push({name:'whisper-http-latency',elapsedMs:Date.now()-started,text:data.text})
})
writeFileSync('.local/http-smoke-results.json',JSON.stringify(results,null,2))
