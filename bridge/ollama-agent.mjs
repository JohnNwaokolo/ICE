import { executeTool, TOOL_DEFINITIONS } from './local-tools.mjs'
import { askedClock } from './local/agent.mjs'
import { createThinkFilter, visibleText } from './local/provider.mjs'

export const OLLAMA_URL = process.env.JARVIS_OLLAMA_URL ?? 'http://127.0.0.1:11434'
export const MODEL = process.env.JARVIS_MODEL ?? 'qwen3:4b'
export const MAX_TOOL_ROUNDS = 4

export const SYSTEM_PROMPT = `You are ICE, a concise local assistant for John Nwaokolo. Runtime inference is local through Ollama. Answer the user's actual question now in 1-3 short sentences, as if talking to a person. Never use numbered lists such as 1. 2. 3. or 1) 2) 3). Do not explain your reasoning. Do not mention Africa/Lagos, WAT, or the clock unless the user asked for the time or date. Call get_lagos_time only when they asked the time or date; forget the clock otherwise. Use tools when relevant and report their actual results. Only open exact entries from list_approved_targets. Do not claim to have done an action unless its tool succeeded. You cannot send messages, delete files, publish content, install software, or run shell commands. Never request or expose credentials. Do not save a memory unless the user adds it through the editable memory controls.`

async function readStream(response, onText, signal) {
  if (!response.body) throw new Error('Ollama returned an empty response stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let content = ''
  let toolCalls = []
  const emitVisible = createThinkFilter(onText)

  const consume = (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      throw new Error('Ollama returned malformed streaming data.')
    }
    if (value.error) throw new Error(`Ollama: ${value.error}`)
    const message = value.message
    if (typeof message?.content === 'string' && message.content) {
      content += message.content
      emitVisible(message.content)
    }
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      toolCalls = message.tool_calls
    }
  }

  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError')
      const { done, value } = await reader.read()
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) consume(line)
      if (done) break
    }
    if (pending.trim()) consume(pending)
  } finally {
    reader.releaseLock()
  }
  emitVisible.flush()
  return { content: visibleText(content), toolCalls }
}

function parseArguments(value) {
  if (value == null || value === '') return {}
  const args = typeof value === 'string' ? JSON.parse(value) : value
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Tool arguments must be a JSON object.')
  }
  return args
}

export async function runOllamaTurn({
  prompt,
  history = [],
  signal,
  onText = () => {},
  onTool = () => {},
  fetchImpl = fetch,
  execute = executeTool,
  model = MODEL,
  apiUrl = OLLAMA_URL,
  maxToolRounds = MAX_TOOL_ROUNDS,
}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-16),
    { role: 'user', content: prompt },
  ]
  let text = ''
  let toolCount = 0

  for (let round = 0; round <= maxToolRounds; round += 1) {
    if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError')
    let response
    try {
      response = await fetchImpl(`${apiUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOL_DEFINITIONS,
          stream: true,
          think: false,
          options: { num_ctx: 1536, num_predict: 80, num_thread: 6, num_batch: 64, num_gpu: 0, think: false },
        }),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new Error(
        `Cannot reach Ollama at ${apiUrl}. Install Ollama from https://ollama.com/download/windows, then run "ollama pull ${model}".`,
      )
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      if (response.status === 404) {
        throw new Error(`Ollama model "${model}" is missing. Run "ollama pull ${model}".`)
      }
      throw new Error(`Ollama returned HTTP ${response.status}: ${detail || response.statusText}`)
    }

    let roundText = ''
    const result = await readStream(response, (delta) => {
      roundText += delta
      text += delta
      onText(delta)
    }, signal)
    const assistant = {
      role: 'assistant',
      content: result.content,
      ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
    }
    messages.push(assistant)

    if (!result.toolCalls.length) {
      if (!text.trim()) throw new Error('Ollama returned no answer. Try again.')
      return { text: text.trim(), history: messages.slice(1) }
    }
    if (round === maxToolRounds || toolCount + result.toolCalls.length > 6) {
      throw new Error('ICE stopped after reaching its local tool-call limit.')
    }

    for (const call of result.toolCalls) {
      if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError')
      const name = call?.function?.name
      const toolCallId = call?.id
      if (typeof name !== 'string' || typeof toolCallId !== 'string') {
        messages.push({ role: 'tool', content: 'Rejected malformed tool call.' })
        continue
      }
      if ((name === 'get_lagos_time' || name === 'get_time') && !askedClock(prompt)) {
        toolCount += 1
        messages.push({ role: 'tool', tool_name: name, tool_call_id: toolCallId, content: JSON.stringify({ ignored: true, error: 'Do not use the clock. The user did not ask for the time or date. Answer their actual question without mentioning Africa/Lagos, WAT, or the time.' }) })
        continue
      }
      onTool(name)
      toolCount += 1
      let content
      try {
        const args = parseArguments(call.function.arguments)
        content = JSON.stringify(await execute(name, args))
      } catch (error) {
        content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      }
      messages.push({ role: 'tool', tool_name: name, tool_call_id: toolCallId, content })
    }
  }
  throw new Error('ICE reached the end of its local tool loop without a reply.')
}