// Real qwen3:4b checks against this installation. Run after model setup.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import WebSocket from 'ws'
const session=JSON.parse(readFileSync('.local/session.json','utf8'))
const results=[]
const ws=new WebSocket(`ws://127.0.0.1:${session.port}/ws`,{headers:{Authorization:`Bearer ${session.token}`}})
await new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no)})
let sequence=0
async function turn(text,{deny=true,cancelAfterText=false}={}) {
 const id=`real-model-${++sequence}`,started=performance.now()
 return new Promise((yes,no)=>{
  let reply='',firstTextMs=null,deltas=0,confirmations=[],tools=[],interrupted=false
  const timer=setTimeout(()=>finish(new Error('Model test exceeded 300 seconds')),300000)
  const finish=(error)=>{clearTimeout(timer);ws.off('message',handle);if(error)no(error);else yes({prompt:text,text:reply,firstTextMs,elapsedMs:Math.round(performance.now()-started),deltas,tools,confirmations,interrupted})}
  const handle=raw=>{
   const m=JSON.parse(raw);if(m.ask!==id)return
   if(m.type==='text') {reply+=m.delta;deltas++;firstTextMs??=Math.round(performance.now()-started);if(cancelAfterText&&!interrupted){interrupted=true;ws.send(JSON.stringify({type:'interrupt'}));setTimeout(()=>finish(),500)}}
   if(m.type==='tool')tools.push(m.name)
   if(m.type==='confirm'){confirmations.push(m.preview);ws.send(JSON.stringify({type:'confirm_result',id:m.id,approved:!deny}))}
   if(m.type==='error'&&!interrupted)finish(new Error(m.message))
   if(m.type==='done'&&!interrupted)finish()
  }
  ws.on('message',handle);ws.send(JSON.stringify({type:'ask',id,text}))
 })
}
try {
 const chat=await turn('Reply with exactly these words: LOCAL MODEL READY.');assert.match(chat.text,/LOCAL MODEL READY/i);assert(chat.deltas>1);results.push({name:'Real local streamed conversation',passed:true,...chat});console.log('PASS real streamed chat',chat.elapsedMs,'ms')
 const clock=await turn('Please use your get_time tool now and tell me the current Lagos date and time.');assert(clock.tools.includes('get_time'));assert(clock.text.trim());results.push({name:'Real model selects and uses clock tool',passed:true,...clock});console.log('PASS real tool calling',clock.elapsedMs,'ms')
 const denied=await turn('Open Notepad now.',{deny:true});assert(denied.tools.includes('open_app'));assert(denied.confirmations.some(p=>p.includes('Notepad')));assert.match(denied.text,/declin|deni|not|cancel|permission|approv/i);results.push({name:'Real model handles denied app action',passed:true,...denied});console.log('PASS denied action',denied.elapsedMs,'ms')
 const stopped=await turn('Explain the history of computers in a long detailed essay.',{cancelAfterText:true});assert(stopped.interrupted);results.push({name:'Live streamed generation interrupted',passed:true,...stopped})
 const next=await turn('What time is it in Lagos?');assert(next.tools.includes('get_time'));assert.match(next.text,/Africa\/Lagos/);results.push({name:'Next request succeeds after interruption',passed:true,...next});console.log('PASS cancellation and next request')
} finally {ws.close();writeFileSync('verification/model-smoke.json',JSON.stringify({checkedAt:new Date().toISOString(),model:'qwen3:4b',results},null,2))}
