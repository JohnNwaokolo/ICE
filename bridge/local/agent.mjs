import { completion, visibleText } from './provider.mjs'
import { toolSchemas } from './tools.mjs'

const APP_ALIASES = [
  [/^(?:notepad(?:\.exe)?|bloc de notas)$/i, 'notepad'],
  [/^(?:calc(?:ulator)?(?:\.exe)?|calculadora)$/i, 'calculator'],
  [/^(?:vs\s*code|vscode|visual studio code)(?:\.exe)?$/i, 'vscode'],
  [/^(?:browser|edge|msedge|chrome|microsoft edge)$/i, 'browser'],
]

export function parseOpenIntent(text) {
  const asked = String(text || '').trim()
  if (!asked || asked.length > 400) return null
  if (/\bgmail\b|mail\.google\.com|accounts\.google/i.test(asked)) return { blocked: 'gmail' }
  const stripped = asked.replace(/^[,\s]*(?:hey|hi|hello|oye|hola)[,\s]+(?:ice|jarvis)[,\s]+/i, '').replace(/[.?!]+$/g, '').trim()
  const open = /^(?:please\s+)?(?:can you\s+|could you\s+|podr[ií]as?\s+)?(?:open|launch|start|abre(?:me)?|abrir)\s+(?:this\s+)?(?:the\s+|el\s+|la\s+|my\s+|mi\s+)?(?:app\s+|application\s+|file\s+|folder\s+|website\s+|site\s+|archivo\s+|carpeta\s+)?(.+)$/i.exec(stripped)
  if (!open) return null
  let target = open[1].replace(/^(?:for me|please|now|once|por favor)\s+/i, '').replace(/\s+(?:for me|please|now|once|por favor)$/i, '').replace(/\s+on(?: the)? (?:my )?(?:desktop|documents|downloads|pictures)$/i, '').trim()
  if (!target) return null
  if (/^https:\/\//i.test(target)) return { name: 'open_website', args: { url: target } }
  const appName = target.replace(/^(?:the\s+|el\s+|la\s+)/i, '').trim()
  for (const [pattern, id] of APP_ALIASES) if (pattern.test(appName)) return { name: 'open_app', args: { id } }
  if (target.split(/\s+/).length > 6) return null
  if (/\.[a-z0-9]{1,8}$/i.test(target) || /[\\/]/.test(target) || /^[a-zA-Z]:/.test(target) || /^(Desktop|Documents|Downloads|Pictures)\b/i.test(target)) {
    return { name: 'open_path', args: { path: target } }
  }
  return { name: 'open_app', args: { id: appName } }
}

async function runForcedOpen({ intent, text, tools, signal, emit }) {
  emit({ type: 'tool', name: intent.name })
  let output
  try { output = await tools.execute(intent.name, intent.args, signal) }
  catch (e) { if (signal.aborted) throw e; output = { error: e.message } }
  const answer = output.error
    ? (/declined/i.test(output.error) ? 'You declined. Nothing was opened.' : `I could not open that. ${output.error}`)
    : intent.name === 'open_app' ? `Opening ${output.label || output.name || intent.args.id}.`
      : intent.name === 'open_website' ? 'Opening that website.'
        : `Opening the ${output.kind || 'file'}${output.path ? '' : ''}.`
  emit({ type: 'text', delta: answer })
  return { text: answer, messages: [{ role: 'user', content: text }, { role: 'assistant', content: answer }] }
}

export function askedClock(text) {
  const asked = String(text || '').trim()
  if (!asked || asked.length > 400) return false
  if (/\b(open|abre|abrir|remember|delete|notepad|website|file|archivo|carpeta)\b/i.test(asked) && !/\b(time|date|hora|fecha|clock)\b/i.test(asked)) return false
  if (/\bget_time\b|\bget_lagos_time\b/i.test(asked)) return true
  const t = asked.replace(/^[,\s]*(?:hey|hi|hello|oye|hola)[,\s]+(?:ice|jarvis)[,\s]+/i, '').replace(/[.?!]+$/g, '').trim()
  if (/^(?:what(?:'s| is)?(?: the)?(?: current)?(?: local)? (?:time|date|day)(?: is it)?(?: now)?(?: in (?:lagos|nigeria|wat))?|(?:tell me|show me|give me)(?: the)?(?: current)? (?:time|date)|(?:current )?(?:time|date)|qu[eé] hora(?: es)?(?: ahora)?(?: en lagos)?|dime la hora|qu[eé] fecha es(?: hoy)?|qu[eé] d[ií]a es(?: hoy)?)$/i.test(t)) return true
  if (/\b(?:the clock|current instant|current time|current date|qu[eé] hora|dime la hora)\b/i.test(asked) && !/\b(meeting|appointment|schedule|flight|class)\b/i.test(asked)) return true
  return false
}

export async function runAgent({ text, history, store, tools, config, signal, emit, complete = completion }) {
  const share = config.provider === 'ollama' || process.env.JARVIS_SHARE_MEMORY === '1'
  const profile = share ? store.profile() : { owner:'the user', notes:'' }
  const memories = share ? store.list().filter(r=>r.kind==='memory').slice(0,6).map(r=>r.text).join('\n').slice(0,800) : ''
  const system = `You are ICE, local assistant for ${profile.owner}. Answer the user's actual question now in 1-3 short sentences, as if talking to a person. Never use numbered lists such as 1. 2. 3. or 1) 2) 3). Do not explain your reasoning. Do not mention Africa/Lagos, WAT, or the clock unless the user asked for the time or date. Do not call get_time unless they asked the time or date. Forget the clock by default. Calendar/agenda → list_records only. To open an app, website, or a file/folder they named → call open_app, open_website, or open_path immediately. Do not ask for confirmation to open. Never open Gmail or secret files. Camera is local-only and stays off until they ask you to look or turn it on. You cannot send, publish, or run arbitrary shell commands.\nProfile: ${profile.notes}\nMemories: ${memories}`
  const messages=[{role:'system',content:system},...history.slice(-6),{role:'user',content:text}]
  const permittedSchemas=share ? toolSchemas : toolSchemas.filter(t=>!['list_records','read_project_file','delete_record'].includes(t.function.name))
  const asked = text.trim()
  const clockOk = askedClock(asked)
  const simpleHi = /^(?:(?:hey|hi|hello|yo|hola)(?:\s+(?:there|ice|jarvis))?|good\s+(?:morning|afternoon|evening)|buenos\s+d[ií]as|buenas\s+(?:tardes|noches))[.!?]?\s*$/i.test(asked)
  if (simpleHi) {
    const answer='Hello. I am here.'
    emit({type:'text',delta:answer}); return {text:answer,messages:[{role:'user',content:text},{role:'assistant',content:answer}]}
  }
  const simpleId = /^(?:(?:hey[ ,]+)?(?:jarvis|ice)[ ,]+)?(?:who are you|what(?:'s| is) your name)[?.!\s]*$/i.test(asked)
  if (simpleId) {
    const answer='I am ICE, your local assistant.'
    emit({type:'text',delta:answer}); return {text:answer,messages:[{role:'user',content:text},{role:'assistant',content:answer}]}
  }
  const simpleClock = /^(?:(?:hey[ ,]+)?(?:jarvis|ice)[ ,]+)?(?:what(?:'s| is)? (?:the )?(?:current )?(?:time|date|day)(?: is it)?(?: today| now)?(?: in lagos| in nigeria)?|(?:tell me|show me) (?:the )?(?:time|date)|time|date|qu[eé] hora es(?: ahora)?(?: en lagos)?|dime la hora|qu[eé] fecha es(?: hoy)?|qu[eé] d[ií]a es(?: hoy)?)[?.!\s]*$/i.test(asked)
  if (simpleClock) {
    emit({type:'tool',name:'get_time'}); const t=await tools.execute('get_time',{},signal)
    const answer=`It is ${t.local} in Africa/Lagos.`
    emit({type:'text',delta:answer}); return {text:answer,messages:[{role:'user',content:text},{role:'assistant',content:answer}]}
  }
  const openIntent = parseOpenIntent(asked)
  if (openIntent?.blocked === 'gmail') {
    const answer='I cannot open Gmail or other accounts. Opening mail and signing in are disabled.'
    emit({type:'text',delta:answer}); return {text:answer,messages:[{role:'user',content:text},{role:'assistant',content:answer}]}
  }
  if (openIntent?.name) return runForcedOpen({ intent: openIntent, text, tools, signal, emit })
  const needsTools=/\b(calendar|agenda|remind|task|remember|open|launch|notepad|website|file|delete|schedule|memory|memories|note|abre|abrir|archivo|carpeta|folder)\b/i.test(asked)
  const activeSchemas=permittedSchemas.filter(t => t.function.name !== 'get_time' || clockOk)
  const offered=(needsTools || clockOk) ? activeSchemas : []
  let answer='', totalCalls=0
  for (let round=0;round<4;round++) {
    signal.throwIfAborted()
    const result=await complete(config,messages,round===0?offered:activeSchemas,signal,delta=>{signal.throwIfAborted();answer+=delta;emit({type:'text',delta})})
    answer=visibleText(answer)
    messages.push(result)
    if (!result.tool_calls?.length) {
      const lateOpen = parseOpenIntent(asked)
      if (lateOpen?.name) return runForcedOpen({ intent: lateOpen, text, tools, signal, emit })
      if (!answer.trim()) throw new Error('The model returned an empty answer. Please retry a shorter question.')
      return {text:answer,messages:[{role:'user',content:text},{role:'assistant',content:answer}]}
    }
    for (const call of result.tool_calls) {
      if (++totalCalls>6) throw new Error('Stopped after six tool calls. Please split the request into smaller steps.')
      signal.throwIfAborted()
      const name=call.function?.name
      if ((name === 'get_time' || name === 'get_lagos_time') && !clockOk) {
        messages.push({role:'tool',tool_name:name,tool_call_id:call.id,content:JSON.stringify({ignored:true,error:'Do not use the clock. The user did not ask for the time or date. Answer their actual question without mentioning Africa/Lagos, WAT, or the time.'})})
        continue
      }
      emit({type:'tool',name})
      let output
      try { if(!permittedSchemas.some(t=>t.function.name===name))throw new Error('This tool is disabled for the selected provider. Local data sharing is not authorized.');output=await tools.execute(name,call.function?.arguments,signal) }
      catch(e) { if(signal.aborted) throw e; output={error:e.message} }
      messages.push({role:'tool',tool_name:name,tool_call_id:call.id,content:JSON.stringify(output)})
    }
  }
  throw new Error('The model reached the four-step limit without a final answer. No extra actions were taken.')
}
