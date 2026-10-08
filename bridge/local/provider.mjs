// John's local adaptation. Upstream MIT notice remains in LICENSE.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const GEMINI_DEFAULT_MODEL = 'gemini-flash-lite-latest'
export const GEMINI_FALLBACK_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
]
export const geminiBusyPolicy = { retries: 2, backoffMs: [300, 800] }

function retiredGeminiName(name) {
  return /gemini-1\.5|gemini-2\.0-flash|gemini-2\.5-flash/i.test(String(name || ''))
}

export function geminiModelOrder(preferred) {
  const start = preferred && preferred !== 'qwen3:4b' && !retiredGeminiName(preferred) ? preferred : GEMINI_DEFAULT_MODEL
  return [...new Set([start, ...GEMINI_FALLBACK_MODELS])].filter(name => !retiredGeminiName(name))
}

export function isGeminiModelName(value) {
  return /^gemini-[a-z0-9][a-z0-9._-]{0,80}$/i.test(String(value || '').trim())
}

export function readPersistedGeminiModel({ localDir, env = process.env } = {}) {
  const fromEnv = String(env?.GEMINI_MODEL || '').trim()
  if (isGeminiModelName(fromEnv)) return fromEnv
  if (!localDir) return ''
  try {
    const fromFile = readFileSync(join(localDir, 'gemini-model'), 'utf8').trim()
    if (isGeminiModelName(fromFile)) return fromFile
  } catch {}
  return ''
}

export function upsertEnvAssignment(text, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Invalid env key')
  if (/[\r\n]/.test(value)) throw new Error('Invalid env value')
  const line = `${key}=${value}`
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (re.test(text)) return text.replace(re, line)
  return `${String(text || '').replace(/\s*$/, '')}\n${line}\n`
}

export function persistGeminiModel(model, { localDir, envPath } = {}) {
  if (!isGeminiModelName(model)) return
  if (localDir) {
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'gemini-model'), model, { encoding: 'utf8' })
  }
  if (envPath && existsSync(envPath)) {
    const text = readFileSync(envPath, 'utf8')
    const next = upsertEnvAssignment(text, 'GEMINI_MODEL', model)
    if (next !== text) writeFileSync(envPath, next)
  }
}

async function waitMs(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0)
  if (signal) signal.throwIfAborted()
  if (!delay) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Reply stopped. You can send another message.'), { name: 'AbortError' }))
    }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  if (signal) signal.throwIfAborted()
}

export function providerConfig(env = process.env, { localDir } = {}) {
  const provider = env.JARVIS_PROVIDER || 'ollama'
  if (provider === 'gemini') {
    const key = env.GEMINI_API_KEY || env.JARVIS_CLOUD_KEY
    if (!key) throw new Error('Gemini needs GEMINI_API_KEY in backend.env on the server. Do not put keys in VITE_* variables.')
    const persisted = readPersistedGeminiModel({ localDir, env })
    const chosen = persisted || ((env.JARVIS_MODEL && env.JARVIS_MODEL !== 'qwen3:4b') ? env.JARVIS_MODEL : (env.JARVIS_CLOUD_MODEL || GEMINI_DEFAULT_MODEL))
    const model = retiredGeminiName(chosen) ? GEMINI_DEFAULT_MODEL : chosen
    return { provider, base: 'https://generativelanguage.googleapis.com/v1beta', model, key }
  }
  if (provider === 'ollama') {
    const base = env.OLLAMA_HOST || 'http://127.0.0.1:11434'
    const url = new URL(base.includes('://') ? base : `http://${base}`)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local mode requires a loopback Ollama address.')
    const model = env.JARVIS_MODEL || 'qwen3:4b'
    if (model !== 'qwen3:4b') throw new Error('This local installation uses qwen3:4b. Cloud models cannot be selected implicitly.')
    return { provider, base: url.origin, model }
  }
  if (provider !== 'openai-compatible' || env.JARVIS_CLOUD_ENABLED !== '1') throw new Error('Cloud mode is disabled. Explicit backend configuration is required; there is no paid fallback.')
  if (!env.JARVIS_CLOUD_URL || !env.JARVIS_CLOUD_MODEL || !env.JARVIS_CLOUD_KEY) throw new Error('Cloud mode needs JARVIS_CLOUD_URL, JARVIS_CLOUD_MODEL and JARVIS_CLOUD_KEY on the backend.')
  const url = new URL(env.JARVIS_CLOUD_URL)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Cloud provider URL must use HTTPS without embedded credentials.')
  return { provider, base: url.href.replace(/\/$/, ''), model: env.JARVIS_CLOUD_MODEL, key: env.JARVIS_CLOUD_KEY }
}

export function redactSecrets(text, env = process.env) {
  let out = String(text || '')
  for (const value of [env.GEMINI_API_KEY, env.JARVIS_CLOUD_KEY, env.GROQ_API_KEY, env.XAI_API_KEY, env.GROK_API_KEY]) {
    if (value && value.length > 6) out = out.split(value).join('[redacted]')
  }
  return out.replace(/AQ\.[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/AIza[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/gsk_[A-Za-z0-9]{8,}/g, '[redacted]').replace(/xai-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

export function alternateBrains(env = process.env) {
  const brains = []
  const seen = new Set()
  const push = (hint, keyName) => {
    const key = String(env[keyName] || '').trim()
    if (!key || key.length < 8 || seen.has(key)) return
    seen.add(key)
    const groq = key.startsWith('gsk_') || (hint === 'groq' && !/^xai-/i.test(key))
    if (groq) brains.push({ provider: 'groq', base: 'https://api.groq.com/openai/v1', model: env.GROQ_MODEL || 'llama-3.3-70b-versatile', key, label: 'Groq' })
    else brains.push({ provider: 'xai', base: 'https://api.x.ai/v1', model: env.XAI_MODEL || env.GROK_MODEL || 'grok-3-mini', key, label: 'Grok' })
  }
  push('groq', 'GROQ_API_KEY')
  push('xai', 'XAI_API_KEY')
  push('xai', 'GROK_API_KEY')
  return brains
}

export function geminiShouldFailover(error) {
  if (!error) return false
  if (error.code === 'GEMINI_BUSY') return true
  const message = String(error.message || '')
  return /HTTP 400|HTTP 404|HTTP 503|INVALID_ARGUMENT|UNAVAILABLE/i.test(message)
}

export function geminiAuthFailed(status, body) {
  const text = String(body || '')
  if ([401, 403].includes(status)) return true
  return status === 400 && /api key not valid|invalid api key|api_key_invalid|invalid x-api-key|consumer.*invalid|api key expired/i.test(text)
}

export function geminiBusy(status, body) {
  const code = Number(status)
  const text = String(body || '')
  if (code === 503) return true
  if (code >= 500 && (/"status"\s*:\s*"UNAVAILABLE"/i.test(text) || /\bUNAVAILABLE\b/.test(text))) return true
  return false
}

function toGeminiParameters(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'OBJECT', properties: {} }
  const out = { type: String(schema.type || 'object').toUpperCase() }
  if (schema.description) out.description = schema.description
  if (schema.enum) out.enum = schema.enum
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiParameters(value)]))
  if (schema.required?.length) out.required = schema.required
  return out
}

export function toGeminiTools(tools) {
  if (!tools?.length) return {}
  return {
    tools: [{ functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: toGeminiParameters(t.function.parameters),
    })) }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  }
}

export function ollamaFallbackConfig(env = process.env) {
  return providerConfig({ ...env, JARVIS_PROVIDER: 'ollama', JARVIS_MODEL: 'qwen3:4b' })
}

const SCRATCH = /^(okay[,.]?\s+)?((the )?user (wants|said|asked|is asking)|let me (check|think|see|look)|i (need to|should|will|am going to)|wait[,.]|hmm+|thinking|scratchpad|el usuario|déjame|voy a pensar)\b/i

export function flattenLists(text) {
  const raw = String(text || '')
  let t = raw.replace(/^[ \t]*(?:\d+[.)]|[-*•])[ \t]+/gm, '')
  if ((raw.match(/^[ \t]*\d+[.)][ \t]+/gm) || []).length >= 2) {
    t = t.split(/\n+/).map(s => s.trim()).filter(Boolean).join('. ')
  } else if ((t.match(/\s\d+[.)]\s/g) || []).length >= 2) {
    t = t.replace(/\s\d+[.)]\s+/g, '. ')
  }
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\.\s*\./g, '.').trim()
}

export function visibleText(raw) {
  let text = String(raw || '')
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '\n')
  const open = text.toLowerCase().lastIndexOf('<think>')
  if (open >= 0) text = text.slice(0, open)
  const close = text.toLowerCase().lastIndexOf('</think>')
  if (close >= 0) text = text.slice(close + 8)
  text = text.replace(/<\/?think>/gi, '')
  const parts = text.split(/\n+/)
  while (parts.length > 1 && SCRATCH.test(parts[0].trim())) parts.shift()
  return flattenLists(parts.join('\n').replace(/^\s+/, ''))
}

function incompleteTag(text) {
  return /<(?:\/)?(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i.test(text.slice(-8))
}

export function createThinkFilter(onText) {
  let buf = ''
  let mode = 'scan'
  const emitAnswer = piece => {
    if (!piece) return
    onText(piece.replace(/(^|\n)[ \t]*(?:\d+[.)]|[-*•])[ \t]+/g, '$1'))
  }
  const feed = chunk => {
    if (!chunk) return
    buf += chunk
    while (buf) {
      if (mode === 'think') {
        const close = buf.toLowerCase().indexOf('</think>')
        if (close < 0) { if (buf.length > 8) buf = buf.slice(-8); return }
        buf = buf.slice(close + 8).replace(/^\s+/, '')
        mode = 'answer'
        continue
      }
      const open = buf.toLowerCase().indexOf('<think>')
      if (open >= 0) {
        const before = buf.slice(0, open)
        if (mode === 'answer' || (mode === 'scan' && before.trim() && !SCRATCH.test(before.trim()))) emitAnswer(before)
        buf = buf.slice(open + 7)
        mode = 'think'
        continue
      }
      if (incompleteTag(buf)) return
      if (mode === 'scan') {
        const close = buf.toLowerCase().indexOf('</think>')
        if (close >= 0) {
          buf = buf.slice(close + 8).replace(/^\s+/, '')
          mode = 'answer'
          continue
        }
        if (SCRATCH.test(buf.trim()) && buf.length < 800) return
        mode = 'answer'
      }
      emitAnswer(buf)
      buf = ''
      return
    }
  }
  feed.flush = () => {
    let leftover = mode === 'think' ? '' : visibleText(buf)
    if (leftover && SCRATCH.test(leftover)) leftover = ''
    buf = ''
    mode = 'answer'
    emitAnswer(leftover)
  }
  return feed
}

async function* lines(stream, signal) {
  const reader = stream.getReader(), decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1)
        if (line) yield line
      }
      if (buffer.length > 2_000_000) throw new Error('Provider returned an oversized stream frame.')
      if (done) { if (buffer.trim()) yield buffer.trim(); break }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function toGeminiContents(messages) {
  let system = ''
  const contents = []
  for (const m of messages || []) {
    if (m.role === 'system') { system += (system ? '\n' : '') + m.content; continue }
    if (m.role === 'tool') {
      let response
      try { response = JSON.parse(m.content) } catch { response = { result: m.content } }
      if (response == null || typeof response !== 'object' || Array.isArray(response)) response = { result: response }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.tool_name || 'tool', response } }] })
      continue
    }
    if (m.role === 'assistant' || m.role === 'model') {
      const parts = []
      if (m.content) parts.push({ text: m.content })
      for (const call of m.tool_calls || []) {
        let args = call.function?.arguments
        if (typeof args === 'string') { try { args = JSON.parse(args || '{}') } catch { args = {} } }
        parts.push({ functionCall: { name: call.function?.name, args: args && typeof args === 'object' ? args : {} } })
      }
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }
    contents.push({ role: 'user', parts: [{ text: m.content || '' }] })
  }
  return { systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents }
}

function geminiInvalidArgument(status, body) {
  return Number(status) === 400 && /INVALID_ARGUMENT|invalid argument|unknown name|Invalid JSON payload|thinkingConfig/i.test(String(body || ''))
}

function geminiRequestVariants(messages, tools) {
  const { systemInstruction, contents } = toGeminiContents(messages)
  const base = { contents, ...(systemInstruction ? { systemInstruction } : {}) }
  const gen = { temperature: 0.4, maxOutputTokens: 320 }
  const decls = toGeminiTools(tools)
  const variants = []
  if (decls.tools) {
    variants.push({ ...base, tools: decls.tools, toolConfig: decls.toolConfig, generationConfig: gen })
    variants.push({ ...base, tools: decls.tools, generationConfig: gen })
  }
  variants.push({ ...base, generationConfig: gen })
  if (decls.tools) {
    variants.push({ ...base, tools: decls.tools, generationConfig: { ...gen, thinkingConfig: { thinkingBudget: 0 } } })
  }
  variants.push({ ...base, generationConfig: { ...gen, thinkingConfig: { thinkingBudget: 0 } } })
  return variants
}

async function completionGemini(config, messages, tools, signal, onText, fetcher) {
  const models = geminiModelOrder(config.model)
  let lastErr
  for (const model of models) {
    try {
      return await completionGeminiModel({ ...config, model }, messages, tools, signal, onText, fetcher)
    } catch (e) {
      lastErr = e
      if (signal.aborted || e.code === 'GEMINI_AUTH') throw e
      if (e.code === 'GEMINI_BUSY') continue
      if (/HTTP 404/i.test(e.message) && /no longer available|not found|not supported/i.test(e.message)) continue
      if (/HTTP 400/i.test(e.message) && /INVALID_ARGUMENT|invalid argument/i.test(e.message)) continue
      throw e
    }
  }
  throw lastErr
}

async function completionGeminiModel(config, messages, tools, signal, onText, fetcher) {
  const url = `${config.base}/models/${config.model}:streamGenerateContent?alt=sse`
  const variants = geminiRequestVariants(messages, tools)
  const send = payload => fetcher(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.key },
    body: JSON.stringify(payload),
  })
  const attempts = 1 + Math.max(0, geminiBusyPolicy.retries)
  let response, lastErr, payload = variants[0]
  let variant = 0
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await waitMs(geminiBusyPolicy.backoffMs[i - 1] ?? 400, signal)
    try {
      response = await send(payload)
      if (!response.ok) {
        let raw = await response.text().catch(() => '')
        while (!response.ok && geminiInvalidArgument(response.status, raw) && variant < variants.length - 1) {
          variant += 1
          payload = variants[variant]
          response = await send(payload)
          if (!response.ok) raw = await response.text().catch(() => '')
        }
        if (!response.ok) {
          lastErr = geminiHttpError(response.status, raw)
          if (lastErr.code === 'GEMINI_BUSY' && i < attempts - 1) continue
          throw lastErr
        }
      }
      lastErr = null
      break
    } catch (e) {
      if (signal.aborted) throw e
      if (e.code === 'GEMINI_BUSY') { lastErr = e; if (i < attempts - 1) continue; throw e }
      if (e.code === 'GEMINI_AUTH' || String(e.message || '').startsWith('Gemini ')) throw e
      lastErr = e
      if (i < attempts - 1) continue
      throw new Error('Cannot reach Google Gemini. Check internet. No paid Claude fallback was used.')
    }
  }
  if (lastErr) throw lastErr
  if (!response?.ok) {
    const raw = await response.text().catch(() => '')
    throw geminiHttpError(response.status, raw)
  }
  let rawContent = '', completed = false
  const calls = new Map()
  const emitVisible = createThinkFilter(onText)
  for await (const raw of lines(response.body, signal)) {
    const line = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim()
    if (!line || line === '[DONE]') { if (line === '[DONE]') completed = true; continue }
    let part
    try { part = JSON.parse(line) } catch { throw new Error('Gemini sent malformed streaming JSON.') }
    if (part.error) throw geminiHttpError(part.error.code || 500, JSON.stringify(part.error))
    const cand = part.candidates?.[0]
    const finish = cand?.finishReason
    if (finish && finish !== 'FINISH_REASON_UNSPECIFIED') completed = true
    for (const piece of cand?.content?.parts || []) {
      if (piece.text) { rawContent += piece.text; emitVisible(piece.text) }
      if (piece.functionCall?.name) {
        const index = calls.size
        calls.set(index, { id: `call_${index}`, type: 'function', function: { name: piece.functionCall.name, arguments: JSON.stringify(piece.functionCall.args || {}) } })
      }
    }
    if (calls.size > 8) throw new Error('Provider requested too many tools in one response.')
  }
  if (!completed && !rawContent && !calls.size) throw new Error('Gemini stream ended before completion. Please retry.')
  if (rawContent || calls.size) completed = true
  emitVisible.flush()
  return { role: 'assistant', content: visibleText(rawContent), model: config.model, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) }
}

function geminiHttpError(status, body) {
  const redacted = redactSecrets(body).slice(0, 240)
  if (geminiAuthFailed(status, body)) {
    const err = new Error(`Gemini rejected the API key (HTTP ${status}). ${redacted}`.trim())
    err.code = 'GEMINI_AUTH'
    return err
  }
  if (geminiBusy(status, body)) {
    const err = new Error(`Gemini returned HTTP ${status}. ${redacted} No paid Claude fallback was used.`.trim())
    err.code = 'GEMINI_BUSY'
    return err
  }
  return new Error(`Gemini returned HTTP ${status}. ${redacted} No paid Claude fallback was used.`.trim())
}

export async function transcribeAudioGemini(config, wavBuffer, signal, fetcher = fetch) {
  if (config?.provider !== 'gemini' || !config.key) throw new Error('Gemini audio is not configured.')
  const audio = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer)
  const b64 = audio.toString('base64')
  const models = geminiModelOrder(config.model)
  let lastErr
  for (const model of models) {
    try {
      const response = await fetcher(`${config.base}/models/${model}:generateContent`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: 'audio/wav', data: b64 } },
            { text: 'Transcribe only the spoken words. Reply with the transcript alone. No labels.' },
          ] }],
          generationConfig: { temperature: 0, maxOutputTokens: 256 },
        }),
      })
      const raw = await response.text().catch(() => '')
      if (!response.ok) throw geminiHttpError(response.status, raw)
      const parsed = JSON.parse(raw)
      const text = (parsed.candidates || []).flatMap(c => c.content?.parts || []).map(p => p.text || '').join(' ').trim()
      if (!text) throw new Error('Gemini returned an empty transcript.')
      return { text: visibleText(text), model, engine: `Gemini ${model} audio` }
    } catch (e) {
      lastErr = e
      if (signal?.aborted || e.code === 'GEMINI_AUTH') throw e
      if (e.code === 'GEMINI_BUSY') continue
      if (/HTTP 404/i.test(e.message || '') && /not found|not supported/i.test(e.message || '')) continue
      throw e
    }
  }
  throw lastErr || new Error('Gemini audio transcription failed. No paid Claude fallback was used.')
}

export async function completion(config, messages, tools, signal, onText, fetcher = fetch) {
  if (config.provider === 'gemini') return completionGemini(config, messages, tools, signal, onText, fetcher)
  const local = config.provider === 'ollama'
  const openaiLike = config.provider === 'openai-compatible' || config.provider === 'groq' || config.provider === 'xai'
  const translated = local ? messages : messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id }
    if (m.tool_calls) return { ...m, tool_calls: m.tool_calls.map(c => ({ ...c, type: 'function', function: { ...c.function, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments) } })) }
    return m
  })
  const outbound = local && !(tools?.length) ? [...translated, { role: 'assistant', content: 'Sure. ' }] : translated
  let response
  try {
    response = await fetcher(`${config.base}${local ? '/api/chat' : '/chat/completions'}`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(local ? {} : { Authorization: `Bearer ${config.key}` }) },
      body: JSON.stringify({ model: config.model, messages: outbound, stream: true,
        ...(tools?.length ? { tools } : {}),
        ...(local ? { think: false, keep_alive: '10m', options: { num_ctx: 1536, num_predict: 80, num_thread: 6, num_batch: 64, num_gpu: 0, temperature: 0.3, think: false, stop: ['<think>', '\nAssistant', '\nUser', '\nOkay,'] } } : { max_tokens: 120, tool_choice: 'auto' }) }),
    })
  } catch (e) {
    if (signal.aborted) throw e
    throw new Error(local ? 'Cannot reach Ollama. Run Start-Jarvis.cmd; check .local/logs/ollama-error.log.' : `Cannot reach ${config.label || config.provider}. No paid Claude fallback was used.`)
  }
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 404 && local) throw new Error('qwen3:4b is not installed. Run Setup-Jarvis.cmd to download it.')
    throw new Error(`${local ? 'Ollama' : (config.label || 'Cloud provider')} returned HTTP ${response.status}. ${[402,429].includes(response.status) ? 'Quota or billing limit reached; no paid fallback was used.' : 'No paid Claude fallback was used.'}`)
  }
  let rawContent = '', completed = false
  const calls = new Map()
  const emitVisible = createThinkFilter(onText)
  for await (const raw of lines(response.body, signal)) {
    if (!local && !raw.startsWith('data:')) continue
    const line = local ? raw : raw.slice(5).trim()
    if (line === '[DONE]') { completed = true; break }
    let part
    try { part = JSON.parse(line) } catch { throw new Error('Provider sent malformed streaming JSON.') }
    if (part.error) throw new Error('Provider reported a model error. Check model installation and available RAM; no fallback was attempted.')
    const delta = local ? part.message : part.choices?.[0]?.delta
    const spoken = delta?.content || ''
    if (spoken) { rawContent += spoken; emitVisible(spoken) }
    for (const [i, call] of (delta?.tool_calls || []).entries()) {
      const index = call.index ?? call.function?.index ?? i
      if (local) calls.set(index, { id: call.id || `call_${index}`, type: 'function', function: call.function })
      else {
        const prev = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (call.id) prev.id = call.id
        if (call.function?.name) prev.function.name += call.function.name
        if (call.function?.arguments) prev.function.arguments += call.function.arguments
        if (prev.function.arguments.length > 24_000) throw new Error('Tool arguments exceed the safety limit.')
        calls.set(index, prev)
      }
    }
    if (calls.size > 8) throw new Error('Provider requested too many tools in one response.')
    if (local && part.done) completed = true
    if (!local && part.choices?.[0]?.finish_reason) completed = true
  }
  if (!completed) throw new Error('Provider stream ended before completion. Please retry.')
  emitVisible.flush()
  return { role: 'assistant', content: visibleText(rawContent), ...(calls.size ? { tool_calls: [...calls.values()] } : {}) }
}
