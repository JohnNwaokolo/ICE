import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { openStore } from '../bridge/local/storage.mjs'
import { providerConfig, completion, visibleText, createThinkFilter, flattenLists, geminiBusyPolicy, persistGeminiModel, upsertEnvAssignment, geminiModelOrder, toGeminiTools, alternateBrains, geminiShouldFailover, redactSecrets } from '../bridge/local/provider.mjs'
import { runAgent, askedClock, parseOpenIntent } from '../bridge/local/agent.mjs'
import { currentTime, createTools, scopedFile, safeUrl, validateTool, resolveOpenTarget, toolSchemas, scoreAppName, findWindowsApps } from '../bridge/local/tools.mjs'

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'jarvis-unit-')),file=join(root,'memory.sqlite')
  const store=openStore(file)
  t.after(()=>{try{store.close()}catch{}rmSync(root,{recursive:true,force:true})})
  return {root,file,store}
}

test('real clock is formatted in Lagos regardless of machine timezone',()=>{
  const result=currentTime(new Date('2026-09-30T23:30:00Z'))
  assert.match(result.local,/1 October 2026/);assert.match(result.local,/00:30:00/);assert.equal(result.timezone,'Africa/Lagos')
})
test('strict tool schema blocks arbitrary commands, extra keys and malformed args',()=>{
  assert.throws(()=>validateTool('shell',{command:'echo hello'}),/not available/)
  assert.throws(()=>validateTool('get_time',{extra:1}),/Unexpected/)
  assert.throws(()=>validateTool('open_app','{'),/JSON/)
  assert.throws(()=>validateTool('delete_record',{id:0}),/Invalid/)
  assert.deepEqual(validateTool('get_time','{}'),{})
})
test('approved paths reject traversal, hidden credentials and outside files',t=>{
  const {root}=fixture(t),project=join(root,'project');mkdirSync(project)
  writeFileSync(join(project,'hello.txt'),'hello');writeFileSync(join(root,'outside.txt'),'private');writeFileSync(join(project,'.env'),'SECRET');writeFileSync(join(project,'credentials.json'),'private');writeFileSync(join(project,'backend.env'),'PRIVATE TEST KEY')
  assert.equal(scopedFile(project,'hello.txt').text,'hello')
  for(const path of ['../outside.txt','.env','backend.env','credentials.json','C:\\Windows\\win.ini'])assert.throws(()=>scopedFile(project,path))
})
test('website opener rejects shell/file schemes, credentials and local hosts',()=>{
  assert.equal(safeUrl('https://example.com'),'https://example.com/')
  for(const url of ['file:///C:/Windows','javascript:alert(1)','https://user:pass@example.com','https://127.0.0.1','https://192.168.1.1','https://mail.google.com'])assert.throws(()=>safeUrl(url))
})
test('SQLite memory survives restart; partial task update preserves text; deleted record is gone',t=>{
  const {store,file}=fixture(t),record=store.save({kind:'task',text:'Test reminder persistence'})
  store.save({done:true},record.id);assert.equal(store.find(record.id).text,'Test reminder persistence');store.close()
  const reopened=openStore(file);assert.equal(reopened.find(record.id).done,true);reopened.remove(record.id);assert.equal(reopened.find(record.id),null);reopened.close()
})
test('reminders are marked once and retain state after restart',t=>{
  const {store,file}=fixture(t),record=store.save({kind:'reminder',text:'Only once',due_at:'2020-01-01T10:00:00+01:00'})
  assert.equal(store.due().length,1);store.markNotified(record.id);store.close()
  const reopened=openStore(file);assert.equal(reopened.due().length,0);reopened.close()
})
test('requested websites and apps open without a permission dialog',async t=>{
  const {root,store}=fixture(t);let launches=0
  const tools=createTools({root,store,confirm:async()=>false,launch:async()=>{launches++;return{launched:true}}})
  const signal=new AbortController().signal
  const result=await tools.execute('open_website',{url:'https://example.com'},signal)
  assert.equal(result.launched,true);assert.equal(launches,1)
  await tools.execute('open_app',{id:'notepad'},signal)
  assert.equal(launches,2)
})
test('deletion rechecks preview snapshot before deleting',async t=>{
  const {root,store}=fixture(t),r=store.save({kind:'memory',text:'original'})
  const tools=createTools({root,store,confirm:async()=>{store.save({text:'changed'},r.id);return true}})
  await assert.rejects(()=>tools.execute('delete_record',{id:r.id},new AbortController().signal),/changed after/)
  assert.equal(store.find(r.id).text,'changed')
})
test('cancellation while awaiting approval prevents deletion',async t=>{
  const {root,store}=fixture(t),controller=new AbortController()
  store.save({kind:'memory',text:'keep'})
  const tools=createTools({root,store,confirm:async()=>{controller.abort();return true}})
  await assert.rejects(()=>tools.execute('delete_record',{id:1},controller.signal))
})
test('provider defaults local; remote Ollama and implicit cloud are rejected',()=>{
  assert.equal(providerConfig({}).model,'qwen3:4b')
  assert.throws(()=>providerConfig({OLLAMA_HOST:'https://example.com'}),/loopback/)
  assert.throws(()=>providerConfig({JARVIS_PROVIDER:'openai-compatible'}),/disabled/)
  assert.throws(()=>providerConfig({JARVIS_MODEL:'paid:cloud'}),/implicitly/)
})
test('Gemini needs a backend key and never logs it',()=>{
  assert.throws(()=>providerConfig({JARVIS_PROVIDER:'gemini'}),/GEMINI_API_KEY/)
  const gem=providerConfig({JARVIS_PROVIDER:'gemini',GEMINI_API_KEY:'test-key-not-real'})
  assert.equal(gem.provider,'gemini')
  assert.equal(gem.model,'gemini-flash-lite-latest')
  assert.equal(gem.base,'https://generativelanguage.googleapis.com/v1beta')
})
test('Gemini stream text is visible and secrets are redacted',async()=>{
  const {redactSecrets}=await import('../bridge/local/provider.mjs')
  assert.match(redactSecrets('bad AQ.Ab8RN6TESTKEYZZZ',{GEMINI_API_KEY:'AQ.Ab8RN6TESTKEYZZZ'}),/\[redacted\]/)
  assert.doesNotMatch(redactSecrets('bad AQ.Ab8RN6TESTKEYZZZ',{GEMINI_API_KEY:'AQ.Ab8RN6TESTKEYZZZ'}),/TESTKEY/)
  const encoder=new TextEncoder()
  const payload='data: '+JSON.stringify({candidates:[{content:{parts:[{text:'Hello from Gemini'}]},finishReason:'STOP'}]})+'\n\n'
  const body=new ReadableStream({start(c){c.enqueue(encoder.encode(payload));c.close()}})
  let output=''
  const result=await completion({provider:'gemini',base:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-3.8-flash',key:'test-key-not-real'},[{role:'user',content:'Hi'}],[],new AbortController().signal,s=>output+=s,async()=>new Response(body,{status:200}))
  assert.equal(output,'Hello from Gemini')
  assert.equal(result.content,'Hello from Gemini')
})
test('NDJSON decoder preserves split chunks, UTF-8 content and structured tool args',async()=>{
  const encoder=new TextEncoder(),data=encoder.encode(JSON.stringify({message:{content:'Hi Jöhn',tool_calls:[{function:{name:'get_time',arguments:{}}}]}})+'\n'+JSON.stringify({done:true})+'\n')
  const body=new ReadableStream({start(c){for(let i=0;i<data.length;i+=3)c.enqueue(data.slice(i,i+3));c.close()}})
  let output=''
  const result=await completion(providerConfig({}),[],[],new AbortController().signal,s=>output+=s,async()=>new Response(body))
  assert.equal(output,'Hi Jöhn');assert.equal(result.tool_calls[0].function.name,'get_time')
})
test('thinking tags and untagged reasoning are stripped from visible replies',()=>{
  assert.equal(visibleText('<think>hidden</think>\nLOCAL MODEL READY.'),'LOCAL MODEL READY.')
  assert.equal(visibleText('Okay, the user wants a phrase.</think>\n\nLOCAL MODEL READY.'),'LOCAL MODEL READY.')
  assert.equal(visibleText('Hi Jöhn'),'Hi Jöhn')
})
test('numbered lists are flattened into spoken sentences',()=>{
  assert.equal(flattenLists('1. First\n2. Second\n3. Third'),'First. Second. Third')
  assert.equal(flattenLists('1) One 2) Two 3) Three'),'One. Two. Three')
  assert.equal(flattenLists('Hello there.'),'Hello there.')
  assert.equal(visibleText('1. Alpha\n2. Beta'),'Alpha. Beta')
})
test('agent system prompt forbids numbered lists',async t=>{
  const {root,store}=fixture(t),tools=createTools({root,store,confirm:async()=>false});let system=''
  await runAgent({text:'Explain photosynthesis in one breath.',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:()=>{},complete:async(_c,m,_t,_s,onText)=>{
    system=m[0].content;onText('Plants make sugar from light.');return{role:'assistant',content:'Plants make sugar from light.'}
  }})
  assert.match(system,/Never use numbered lists/)
  assert.match(system,/1\) 2\) 3\)/)
  assert.match(system,/Do not mention Africa\/Lagos/)
  assert.match(system,/Forget the clock by default/)
  assert.doesNotMatch(system,/Timezone Africa\/Lagos/)
})
test('stream filter drops split think chunks and never emits scratchpad',()=>{
  let output=''
  const feed=createThinkFilter(s=>output+=s)
  for (const piece of ['<th','ink>Okay, the user wants a phrase. Hidden analysis.','</thi','nk>\nIce is ready.']) feed(piece)
  feed.flush()
  assert.equal(output,'Ice is ready.')
  output=''
  const untagged=createThinkFilter(s=>output+=s)
  untagged('Okay, the user wants the time.</think>\n\nIt is noon in Lagos.')
  untagged.flush()
  assert.equal(output,'It is noon in Lagos.')
  assert.doesNotMatch(output,/<think>|Okay, the user/i)
  output=''
  const live=createThinkFilter(s=>output+=s)
  live('Hello')
  assert.equal(output,'Hello')
})
test('Ollama chat requests disable thinking and ignore thinking fields',async()=>{
  const encoder=new TextEncoder()
  const payload=JSON.stringify({message:{thinking:'Let me think about Lagos.',content:'<think>scratch</think>It is noon in Lagos.'}})+'\n'+JSON.stringify({done:true})+'\n'
  const body=new ReadableStream({start(c){c.enqueue(encoder.encode(payload));c.close()}})
  let output='', sent
  const result=await completion(providerConfig({}),[],[],new AbortController().signal,s=>output+=s,async(_url,opts)=>{sent=JSON.parse(opts.body);return new Response(body)})
  assert.equal(sent.think,false)
  assert.equal(sent.options.think,false)
  assert.equal(sent.options.num_predict,80)
  assert.equal(sent.options.num_ctx,1536)
  assert.equal(sent.messages.at(-1).role,'assistant')
  assert.equal(sent.messages.at(-1).content,'Sure. ')
  assert.equal(output,'It is noon in Lagos.')
  assert.equal(result.content,'It is noon in Lagos.')
  assert.doesNotMatch(output,/Let me think|scratch|<think>/i)
})
test('hello and Lagos time answer immediately without the model',async t=>{
  const {root,store}=fixture(t),tools=createTools({root,store,confirm:async()=>false});let calls=0
  const fail=async()=>{calls++;throw new Error('model should not run')}
  const hi=await runAgent({text:'Hello',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:()=>{},complete:fail})
  assert.equal(hi.text,'Hello. I am here.')
  const who=await runAgent({text:'Who are you?',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:()=>{},complete:fail})
  assert.equal(who.text,'I am ICE, your local assistant.')
  const clock=await runAgent({text:'What time is it in Lagos?',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:()=>{},complete:fail})
  assert.match(clock.text,/Africa\/Lagos/)
  const spanishClock=await runAgent({text:'Qué hora es?',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:()=>{},complete:fail})
  assert.match(spanishClock.text,/Africa\/Lagos/)
  assert.equal(calls,0)
})
test('quota exhaustion has no automatic fallback',async()=>{
  let requests=0
  await assert.rejects(()=>completion({provider:'openai-compatible',base:'https://example.com',model:'optional',key:'test'},[],[],new AbortController().signal,()=>{},async()=>{requests++;return new Response('',{status:429})}),/no paid fallback/)
  assert.equal(requests,1)
})
test('agent executes tool, appends actual result and streams final answer',async t=>{
  const {root,store}=fixture(t),tools=createTools({root,store,confirm:async()=>false});let rounds=0,events=[]
  const result=await runAgent({text:'Use the clock and tell me the current instant please.',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:e=>events.push(e),complete:async(_c,m,_t,_s,onText)=>{
    if(rounds++===0)return{role:'assistant',content:'',tool_calls:[{id:'c1',function:{name:'get_time',arguments:{}}}]}
    assert.equal(m.at(-1).role,'tool');assert.equal(JSON.parse(m.at(-1).content).timezone,'Africa/Lagos')
    onText('Clock checked.');return{role:'assistant',content:'Clock checked.'}
  }})
  assert.equal(result.text,'Clock checked.');assert.equal(events[0].name,'get_time');assert.equal(rounds,2)
})
test('cloud opt-out blocks memory tools even when provider invents calls',async t=>{
  const {root,store}=fixture(t);store.save({kind:'memory',text:'PRIVATE SENTINEL'})
  const tools=createTools({root,store,confirm:async()=>false});let round=0
  await runAgent({text:'What do you remember?',history:[],store,tools,config:{provider:'openai-compatible'},signal:new AbortController().signal,emit:()=>{},complete:async(_c,m,schemas,_s,onText)=>{
    assert.ok(!JSON.stringify(m).includes('PRIVATE SENTINEL'));assert.ok(!schemas.some(t=>t.function.name==='list_records'))
    if(round++===0)return{role:'assistant',content:'',tool_calls:[{id:'x',function:{name:'list_records',arguments:{}}}]}
    assert.match(m.at(-1).content,/not authorized/);onText('Unavailable.');return{role:'assistant',content:'Unavailable.'}
  }})
})
test('bounded agent loop stops repeated tool requests',async t=>{
  const {root,store}=fixture(t),tools=createTools({root,store,confirm:async()=>false});let rounds=0
  await assert.rejects(()=>runAgent({text:'Repeat forever',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:()=>{},complete:async()=>{rounds++;return{role:'assistant',content:'',tool_calls:[{id:'x',function:{name:'get_time',arguments:{}}}]}}}),/four-step limit/)
  assert.equal(rounds,4)
})
test('clock intent only matches real time questions',()=>{
  assert.equal(askedClock('What time is it?'),true)
  assert.equal(askedClock('Qué hora es'),true)
  assert.equal(askedClock('Explain photosynthesis in one breath.'),false)
  assert.equal(askedClock('abre este archivo'),false)
  assert.equal(askedClock('Open notes.txt on Desktop'),false)
})
test('spurious get_time is dropped unless the user asked the clock',async t=>{
  const {root,store}=fixture(t);let executed=[],round=0,events=[]
  const inner=createTools({root,store,confirm:async()=>false})
  const tools={execute:async(name,args,signal)=>{executed.push(name);return inner.execute(name,args,signal)}}
  const result=await runAgent({text:'Explain photosynthesis in one breath.',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:e=>events.push(e),complete:async(_c,m,schemas,_s,onText)=>{
    assert.ok(!schemas.some(t=>t.function.name==='get_time'))
    if(round++===0)return{role:'assistant',content:'',tool_calls:[{id:'c1',function:{name:'get_time',arguments:{}}}]}
    assert.match(m.at(-1).content,/did not ask/)
    onText('Plants turn light into sugar.');return{role:'assistant',content:'Plants turn light into sugar.'}
  }})
  assert.equal(result.text,'Plants turn light into sugar.')
  assert.ok(!executed.includes('get_time'))
  assert.ok(!events.some(e=>e.name==='get_time'))
  assert.doesNotMatch(result.text,/Lagos|WAT/i)
})
test('open_path launches immediately; secrets and missing files are refused',async t=>{
  const {root,store}=fixture(t)
  const file=join(root,'notes.txt');writeFileSync(file,'hello')
  writeFileSync(join(root,'.env'),'SECRET=1')
  writeFileSync(join(root,'backend.env'),'SECRET=1')
  let launches=0
  const tools=createTools({root,store,confirm:async()=>false,launch:async()=>{launches++;return{launched:true}}})
  const signal=new AbortController().signal
  const opened=await tools.execute('open_path',{path:file},signal)
  assert.equal(opened.launched,true);assert.equal(opened.kind,'file');assert.equal(launches,1)
  await assert.rejects(()=>tools.execute('open_path',{path:join(root,'.env')},signal),/Secret/)
  await assert.rejects(()=>tools.execute('open_path',{path:join(root,'backend.env')},signal),/Secret/)
  await assert.rejects(()=>tools.execute('open_path',{path:join(root,'missing-nope.txt')},signal),/could not find/)
  const still=createTools({root,store,confirm:async()=>false,launch:async()=>{launches++;return{launched:true}}})
  await still.execute('open_path',{path:file},signal)
  assert.equal(launches,2)
  const home=join(root,'home');mkdirSync(join(home,'Desktop'),{recursive:true})
  writeFileSync(join(home,'Desktop','ice-open-test.txt'),'ok')
  assert.equal(resolveOpenTarget('ice-open-test.txt',{home}).kind,'file')
})
test('open/abre intent maps to local tools and refuses Gmail',()=>{
  assert.deepEqual(parseOpenIntent('Open notepad now.'),{name:'open_app',args:{id:'notepad'}})
  assert.deepEqual(parseOpenIntent('abre notepad'),{name:'open_app',args:{id:'notepad'}})
  assert.deepEqual(parseOpenIntent('open notes.txt'),{name:'open_path',args:{path:'notes.txt'}})
  assert.equal(parseOpenIntent('Open Gmail').blocked,'gmail')
  assert.equal(parseOpenIntent('What time is it?'),null)
})
test('open notepad launches immediately even if the model never calls a tool',async t=>{
  const {root,store}=fixture(t);let launches=0,completeCalls=0,events=[]
  const tools=createTools({root,store,confirm:async()=>false,launch:async()=>{launches++;return{launched:true,pid:1}}})
  const result=await runAgent({text:'Open notepad now.',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:e=>events.push(e),complete:async()=>{completeCalls++;throw new Error('model should not run for open intent')}})
  assert.equal(launches,1);assert.equal(completeCalls,0)
  assert.ok(events.some(e=>e.name==='open_app'))
  assert.match(result.text,/Opening notepad/i)
})
test('open gmail is refused and never launches',async t=>{
  const {root,store}=fixture(t);let launches=0
  const tools=createTools({root,store,confirm:async()=>true,launch:async()=>{launches++;return{launched:true}}})
  const result=await runAgent({text:'Open Gmail',history:[],store,tools,config:providerConfig({}),signal:new AbortController().signal,emit:()=>{},complete:async()=>{throw new Error('model should not run')}})
  assert.equal(launches,0)
  assert.match(result.text,/cannot open Gmail/i)
})
test('Gemini 503 retries then uses the next Flash model on the same key',async t=>{
  const prev=geminiBusyPolicy.backoffMs.slice();geminiBusyPolicy.backoffMs=[0,0]
  t.after(()=>{geminiBusyPolicy.backoffMs=prev})
  const urls=[]
  const ok='data: '+JSON.stringify({candidates:[{content:{parts:[{text:'from 2.5'}]},finishReason:'STOP'}]})+'\n\n'
  const fetcher=async url=>{
    urls.push(url)
    if (String(url).includes('gemini-3.8-flash')) return new Response(JSON.stringify({error:{code:503,status:'UNAVAILABLE',message:'high demand'}}),{status:503})
    const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(ok));c.close()}})
    return new Response(body,{status:200})
  }
  let output=''
  const result=await completion({provider:'gemini',base:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-3.8-flash',key:'test-key-not-real'},[{role:'user',content:'Hi'}],[],new AbortController().signal,s=>output+=s,fetcher)
  assert.equal(result.content,'from 2.5');assert.equal(result.model,'gemini-flash-lite-latest');assert.equal(output,'from 2.5')
  assert.equal(urls.filter(u=>String(u).includes('gemini-3.8-flash')).length,3)
  assert.ok(urls.some(u=>String(u).includes('gemini-flash-lite-latest')))
  assert.ok(!urls.some(u=>String(u).includes('gemini-1.5-flash')||String(u).includes('gemini-2.0-flash')||String(u).includes('gemini-2.5-flash')))
  assert.doesNotMatch(JSON.stringify(urls),/test-key-not-real/)
})
test('all Gemini 503s surface GEMINI_BUSY so local qwen can take the turn',async t=>{
  const prev=geminiBusyPolicy.backoffMs.slice();geminiBusyPolicy.backoffMs=[0,0]
  t.after(()=>{geminiBusyPolicy.backoffMs=prev})
  await assert.rejects(()=>completion({provider:'gemini',base:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-3.8-flash',key:'test-key-not-real'},[{role:'user',content:'Hi'}],[],new AbortController().signal,()=>{},async()=>new Response(JSON.stringify({error:{code:503,status:'UNAVAILABLE'}}),{status:503})),err=>{
    assert.equal(err.code,'GEMINI_BUSY')
    assert.match(err.message,/No paid Claude fallback/)
    return true
  })
})
test('persisting GEMINI_MODEL does not rewrite or leak the API key',t=>{
  const {root}=fixture(t),envPath=join(root,'backend.env'),localDir=join(root,'.local')
  writeFileSync(envPath,'GEMINI_API_KEY=secret-test-key-xyz\nJARVIS_PROVIDER=gemini\n')
  persistGeminiModel('gemini-flash-lite-latest',{localDir,envPath})
  const saved=readFileSync(envPath,'utf8')
  assert.match(saved,/^GEMINI_MODEL=gemini-flash-lite-latest$/m)
  assert.match(saved,/secret-test-key-xyz/)
  assert.equal(upsertEnvAssignment('GEMINI_API_KEY=keep-me\n','GEMINI_MODEL','gemini-flash-latest').includes('keep-me'),true)
  assert.equal(readFileSync(join(localDir,'gemini-model'),'utf8'),'gemini-flash-lite-latest')
  assert.deepEqual(geminiModelOrder('gemini-3.8-flash')[0],'gemini-3.8-flash')
  assert.ok(!geminiModelOrder('gemini-1.5-flash').includes('gemini-1.5-flash'))
  assert.equal(geminiModelOrder('gemini-1.5-flash')[0],'gemini-flash-lite-latest')
  assert.ok(!geminiModelOrder('gemini-2.5-flash').includes('gemini-2.5-flash'))
  assert.equal(geminiModelOrder('gemini-2.5-flash')[0],'gemini-flash-lite-latest')
})
test('Gemini requests include function declarations for open tools',async()=>{
  let sent
  const ok='data: '+JSON.stringify({candidates:[{content:{parts:[{functionCall:{name:'open_app',args:{id:'notepad'}}}]},finishReason:'STOP'}]})+'\n\n'
  const result=await completion({provider:'gemini',base:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-2.5-flash',key:'test-key-not-real'},[{role:'user',content:'Open notepad'}],toolSchemas.filter(t=>['open_app','open_path','open_website'].includes(t.function.name)),new AbortController().signal,()=>{},async(_url,opts)=>{
    sent=JSON.parse(opts.body)
    const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(ok));c.close()}})
    return new Response(body,{status:200})
  })
  const names=sent.tools[0].functionDeclarations.map(f=>f.name)
  assert.ok(names.includes('open_app') && names.includes('open_path') && names.includes('open_website'))
  assert.equal(sent.tools[0].functionDeclarations[0].parameters.type,'OBJECT')
  assert.ok(!sent.generationConfig?.thinkingConfig)
  assert.equal(result.tool_calls[0].function.name,'open_app')
  assert.ok(toGeminiTools(toolSchemas).tools[0].functionDeclarations.some(f=>f.name==='open_app'))
})
test('alternate brains map Groq gsk_ and xAI keys and never leak them',()=>{
  assert.equal(alternateBrains({}).length,0)
  const groq=alternateBrains({GROQ_API_KEY:'gsk_testkeyvalue'})
  assert.equal(groq[0].provider,'groq')
  assert.equal(groq[0].base,'https://api.groq.com/openai/v1')
  const grokAsGroq=alternateBrains({GROK_API_KEY:'gsk_otherkeyvalue'})
  assert.equal(grokAsGroq[0].provider,'groq')
  const xai=alternateBrains({XAI_API_KEY:'xai-testkeyvalue'})
  assert.equal(xai[0].provider,'xai')
  assert.equal(xai[0].base,'https://api.x.ai/v1')
  assert.equal(xai[0].label,'Grok')
  assert.ok(geminiShouldFailover({code:'GEMINI_BUSY'}))
  assert.ok(geminiShouldFailover({message:'Gemini returned HTTP 400. INVALID_ARGUMENT'}))
  assert.ok(geminiShouldFailover({message:'Gemini returned HTTP 404. not found'}))
  assert.match(redactSecrets('use gsk_testkeyvalue now',{GROQ_API_KEY:'gsk_testkeyvalue'}),/\[redacted\]/)
  assert.doesNotMatch(redactSecrets('use gsk_testkeyvalue now',{GROQ_API_KEY:'gsk_testkeyvalue'}),/testkeyvalue/)
})
test('BB Racing fuzzy match opens the best shortcut without confirm',async t=>{
  const {root,store}=fixture(t)
  const dir=join(root,'Start Menu')
  mkdirSync(dir)
  writeFileSync(join(dir,'BB Racing.lnk'),'x')
  assert.equal(scoreAppName('bb racing','BB Racing'),100)
  assert.ok(scoreAppName('bbracing','BB Racing')>=80)
  const hits=findWindowsApps('BB Racing',{home:root,extraDirs:[dir],skipSystem:true})
  assert.equal(hits[0].name,'BB Racing')
  store.set('projectRoot',dir)
  let launched=''
  const tools=createTools({root,store,confirm:async()=>false,launch:async(_cmd,args)=>{launched=String(args.at(-1)||'');return{launched:true,pid:11}}})
  const result=await tools.execute('open_app',{id:'BB Racing'},new AbortController().signal)
  assert.equal(result.launched,true)
  assert.equal(result.label,'BB Racing')
  assert.match(launched,/BB Racing/)
  await assert.rejects(()=>tools.execute('open_app',{id:'gmail'},new AbortController().signal),/Gmail/)
  assert.deepEqual(parseOpenIntent('Open BB Racing'),{name:'open_app',args:{id:'BB Racing'}})
})
test('real Windows Notepad launches without confirm',async t=>{
  const notepad=join(process.env.SystemRoot || 'C:\\Windows','System32','notepad.exe')
  if (process.platform!=='win32' || !existsSync(notepad)) { t.skip('Notepad is not available on this OS.') ; return }
  const {root,store}=fixture(t)
  const tools=createTools({root,store,confirm:async()=>false})
  const result=await tools.execute('open_app',{id:'notepad'},new AbortController().signal)
  assert.equal(result.launched,true)
  assert.ok(result.pid || /notepad/i.test(String(result.path || result.label || '')))
  if (result.pid) {
    const listed=spawnSync('tasklist',['/FI',`PID eq ${result.pid}`],{encoding:'utf8',windowsHide:true})
    if (/notepad/i.test(listed.stdout || '')) spawnSync('taskkill',['/PID',String(result.pid),'/F'],{windowsHide:true,stdio:'ignore'})
  }
})
