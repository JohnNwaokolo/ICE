import { BRIDGE_HTTP_URL, BRIDGE_WS_URL } from '../config'
import type { AskHandlers } from './anthropic'

export type Confirmation = { id: string; preview: string; ask?: string }
export type ConnectionState = 'open' | 'lost' | 'reconnected'
let socket: WebSocket | null = null
let connecting: Promise<void> | null = null
let everConnected = false
let onConnection: (state: ConnectionState) => void = () => {}
let onConfirmation: (request: Confirmation | null) => void = () => {}
let onReminder: (request: {id: string; text: string}) => void = () => {}
let onHistoryCleared: () => void = () => {}
let onStatus: (message: string) => void = () => {}
let generation = 0
type Pending = {
  id: string; text: string; tools: string[]; handlers: AskHandlers
  resolve: (value: {text: string; tools: string[]}) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}
let pending: Pending | null = null
let authentication: Promise<void> | null = null

export function watchConnection(fn: typeof onConnection) { onConnection = fn }
export function watchConfirmation(fn: typeof onConfirmation) { onConfirmation = fn }
export function watchReminder(fn: typeof onReminder) { onReminder = fn }
export function watchHistoryCleared(fn: typeof onHistoryCleared) { onHistoryCleared = fn }
export function watchStatus(fn: typeof onStatus) { onStatus = fn }
export const isConnected = () => socket?.readyState === WebSocket.OPEN

export async function transcribeClip(wav: Blob, signal?: AbortSignal): Promise<{text: string; engine?: string}> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/api/transcribe`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
    signal,
  })
  const raw = await res.text()
  let data: {text?: string; engine?: string; error?: string; message?: string} = {}
  try { data = raw ? JSON.parse(raw) : {} } catch { data = { error: raw.slice(0, 300) } }
  if (!res.ok) throw new Error(data.error || data.message || `Speech request failed (${res.status}).`)
  if (!data.text?.trim()) throw new Error('No clear speech was detected.')
  return { text: data.text.trim(), engine: data.engine }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${BRIDGE_HTTP_URL}${path}`, { ...init, credentials: 'same-origin', headers: {
    ...(init.body && typeof init.body === 'string' ? {'Content-Type': 'application/json'} : {}),
    ...init.headers,
  } })
  const raw = await res.text()
  let data: unknown
  try { data = raw ? JSON.parse(raw) : null } catch { data = {error: raw.slice(0, 300)} }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Local session expired. Reopen ICE using Start-Jarvis.cmd.')
    const error = data as {error?: string; message?: string}
    throw new Error(error?.error || error?.message || `Request failed (${res.status}).`)
  }
  return data as T
}

export function establishSession(): Promise<void> {
  if (authentication) return authentication
  const token = new URLSearchParams(location.hash.slice(1)).get('token')
  if (!token) return Promise.resolve()
  // Remove the launch credential before rendering links or making further requests.
  history.replaceState(null, '', location.pathname + location.search)
  authentication = api('/api/session', {method: 'POST', headers: {Authorization: `Bearer ${token}`}}).then(() => {})
  return authentication
}

function finish(error?: Error) {
  if (!pending) return
  const p = pending
  pending = null
  clearTimeout(p.timeout)
  onConfirmation(null)
  if (error) p.reject(error)
  else p.resolve({text: p.text, tools: p.tools})
}

export function connect(): Promise<void> {
  if (isConnected()) return Promise.resolve()
  if (connecting) return connecting
  connecting = new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_WS_URL)
    socket = ws
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Local bridge did not connect. Run Start-Jarvis.cmd.')) }, 10000)
    ws.onopen = () => {
      clearTimeout(timeout)
      onConnection(everConnected ? 'reconnected' : 'open')
      everConnected = true
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('Cannot connect to the local bridge. Reopen ICE using Start-Jarvis.cmd.'))
    }
    ws.onclose = () => {
      clearTimeout(timeout)
      if (socket === ws) socket = null
      onConnection('lost')
      finish(new Error('Connection lost. Your partial reply is kept. Reconnect to continue.'))
      reject(new Error('The local bridge closed the connection.'))
    }
    ws.onmessage = event => {
      let f: {type?: string; id?: string; ask?: string; delta?: string; text?: string; name?: string; message?: string; error?: string; preview?: string}
      try { f = JSON.parse(String(event.data)) } catch { return }
      if (f.type === 'reminder' && f.id !== undefined && f.text) { onReminder({id: String(f.id), text: f.text}); return }
      if (f.type === 'status' && f.message) { onStatus(String(f.message)); return }
      if (f.type === 'history_cleared') { cancel(); onHistoryCleared(); return }
      if (f.type === 'confirm') {
        if (pending && (!f.ask || f.ask === pending.id) && f.id) onConfirmation({id: f.id, preview: f.preview || 'Approve this action?', ask: f.ask})
        return
      }
      if (!pending || (f.ask && f.ask !== pending.id) || (f.id && f.id !== pending.id)) return
      if (f.type === 'text') {
        const delta = f.delta ?? f.text ?? ''
        pending.text += delta
        pending.handlers.onText(delta)
      } else if (f.type === 'tool') {
        pending.tools.push(f.name || 'local tool')
        pending.handlers.onTool(f.name || 'local tool')
      } else if (f.type === 'done') finish()
      else if (f.type === 'error') finish(new Error(f.message || f.error || 'The local model returned an error.'))
    }
  }).finally(() => { connecting = null })
  return connecting
}

export async function ask(prompt: string, handlers: AskHandlers): Promise<{text: string; tools: string[]}> {
  cancel()
  const mine = generation
  await connect()
  if (mine !== generation) throw new DOMException('Stopped by you.', 'AbortError')
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pending?.id !== id) return
      if (isConnected()) socket!.send(JSON.stringify({type: 'interrupt', id}))
      finish(new Error('Response timed out. Check Ollama in Settings and try a shorter question.'))
    }, 300000)
    pending = {id, handlers, text: '', tools: [], resolve, reject, timeout}
    socket!.send(JSON.stringify({type: 'ask', id, text: prompt, prompt}))
  })
}

export function answerConfirmation(id: string, approved: boolean) {
  if (isConnected()) socket!.send(JSON.stringify({type: 'confirm_result', id, approved}))
  onConfirmation(null)
}

export function cancel() {
  generation++
  if (pending && isConnected()) socket!.send(JSON.stringify({type: 'interrupt', id: pending.id}))
  finish(new DOMException('Stopped by you.', 'AbortError'))
}
