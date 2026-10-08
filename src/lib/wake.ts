/** Light always-on listen. Web Speech is primary; energy+clip is fallback only. */
import { getMic } from './audio'
import { encodeWav } from './voice'
import { parseWake } from './wake-parse.mjs'
import { webSpeechAvailable, startWebSpeechWake } from './webSpeech'

export type WakeKind = 'ignore' | 'wake-only' | 'command'
export type WakeHit = { kind: WakeKind; command: string }
export type WakeListen = {
  stop: () => void
  setPaused: (on: boolean) => void
  setGuard: (on: boolean) => void
}

export { parseWake }

const TRIGGER = 2.4
const RELEASE = 0.5
const START_MS = 90
const SILENCE_MS = 850
const MAX_MS = 20000
const MIN_MS = 280
const TICK_MS = 50
const COOLDOWN_MS = 1200
const HEARING_MS = 10000
const LEVEL_MS = 100

export async function startWakeListen(h: {
  onLevel: (level: number) => void
  onHearing: () => void
  onWake: () => void
  onUtterance: (text: string) => void
  onPartial?: (text: string) => void
  transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>
  canTranscribe?: () => boolean
  onError: (message: string) => void
}): Promise<WakeListen> {
  if (webSpeechAvailable()) return startWebSpeechWake(h)
  return startEnergyWake(h)
}

async function startEnergyWake(h: {
  onLevel: (level: number) => void
  onHearing: () => void
  onWake: () => void
  onUtterance: (text: string) => void
  transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>
  canTranscribe?: () => boolean
  onError: (message: string) => void
}): Promise<WakeListen> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone needs localhost and a browser with audio recording support.')
  }
  let stream: MediaStream
  try {
    stream = await getMic()
  } catch (error) {
    const name = (error as DOMException).name
    throw new Error(name === 'NotAllowedError'
      ? 'Microphone access denied. Click Allow for this localhost page in your browser, then enable the microphone.'
      : name === 'NotFoundError' ? 'No microphone found. Connect or enable a Windows input device.'
      : `Cannot open microphone: ${(error as Error).message}`)
  }

  let context: AudioContext
  try { context = new AudioContext({ sampleRate: 16000 }) }
  catch { context = new AudioContext() }
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.35
  source.connect(analyser)
  const time = new Float32Array(analyser.fftSize)

  let stopped = false
  let paused = false
  let guard = false
  let hearing = false
  let transcribing = false
  let floor = 0.008
  let smooth = 0
  let speaking = false
  let armedAt = 0
  let speechAt = 0
  let lastLoud = 0
  let lastWhisper = 0
  let lastLevelAt = 0
  let frames = 0
  let chunks: Float32Array[] = []
  let hearingTimer: ReturnType<typeof setTimeout> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let abort: AbortController | null = null
  let processor: ScriptProcessorNode | null = null
  let silent: GainNode | null = null

  const clearHearing = () => {
    hearing = false
    if (hearingTimer) clearTimeout(hearingTimer)
    hearingTimer = null
  }
  const armHearing = () => {
    hearing = true
    if (hearingTimer) clearTimeout(hearingTimer)
    hearingTimer = setTimeout(() => {
      hearing = false
      if (!stopped && !paused) h.onWake()
    }, HEARING_MS)
    h.onHearing()
  }
  const stopCapture = () => {
    if (processor) {
      processor.onaudioprocess = null
      try { processor.disconnect(); silent?.disconnect() } catch { /* already gone */ }
      processor = null
      silent = null
    }
  }
  const discard = () => {
    stopCapture()
    chunks = []
    frames = 0
    speaking = false
    armedAt = 0
    speechAt = 0
  }
  const startCapture = () => {
    if (processor) return
    processor = context.createScriptProcessor(2048, 1, 1)
    silent = context.createGain()
    silent.gain.value = 0
    source.connect(processor)
    processor.connect(silent)
    silent.connect(context.destination)
    processor.onaudioprocess = event => {
      if (stopped || paused) return
      if (!speaking && armedAt === 0) return
      const input = event.inputBuffer.getChannelData(0)
      chunks.push(input.slice())
      frames += input.length
    }
  }

  const finishSpeech = () => {
    const captured = chunks
    const count = frames
    const started = speechAt
    discard()
    const ms = performance.now() - started
    if (ms < MIN_MS || count < context.sampleRate * 0.22) {
      if (!hearing) h.onWake()
      return
    }
    if (transcribing) return
    if (h.canTranscribe && !h.canTranscribe()) {
      if (!hearing) h.onWake()
      return
    }
    const now = performance.now()
    if (!hearing && now - lastWhisper < COOLDOWN_MS) {
      h.onWake()
      return
    }
    lastWhisper = now
    const samples = new Float32Array(count)
    let offset = 0
    for (const chunk of captured) { samples.set(chunk, offset); offset += chunk.length }
    const wav = encodeWav(samples, context.sampleRate)
    transcribing = true
    abort = new AbortController()
    void h.transcribe(wav, abort.signal).then(text => {
      if (stopped) return
      const hit = parseWake(text, hearing)
      if (hit.kind === 'ignore') {
        if (!hearing) h.onWake()
        return
      }
      if (hit.kind === 'wake-only') {
        armHearing()
        return
      }
      clearHearing()
      h.onUtterance(hit.command)
    }).catch(error => {
      if (stopped || (error as Error).name === 'AbortError') return
      const message = error instanceof Error ? error.message : String(error)
      if (/silent|too quiet|No clear speech/i.test(message)) {
        if (!hearing) h.onWake()
        return
      }
      h.onError(message)
    }).finally(() => { transcribing = false; abort = null })
  }

  const rms = () => {
    analyser.getFloatTimeDomainData(time)
    let sum = 0
    for (let i = 0; i < time.length; i++) sum += time[i] * time[i]
    return Math.sqrt(sum / time.length)
  }

  tickTimer = setInterval(() => {
    if (stopped) return
    const energy = rms()
    smooth += (energy - smooth) * 0.4
    const now = performance.now()
    if (!paused && now - lastLevelAt >= LEVEL_MS) {
      lastLevelAt = now
      h.onLevel(Math.min(1, smooth * 8))
    }
    if (paused || transcribing || guard) {
      if (speaking) discard()
      return
    }
    if (!speaking && armedAt === 0) {
      const rate = smooth > floor ? 0.0008 : 0.02
      floor += (smooth - floor) * rate
      floor = Math.max(floor, 0.0012)
    }
    const threshold = floor * TRIGGER
    if (!speaking) {
      if (smooth > threshold) {
        if (armedAt === 0) {
          armedAt = now
          startCapture()
        } else if (now - armedAt >= START_MS) {
          speaking = true
          speechAt = armedAt
          lastLoud = now
          h.onHearing()
        }
      } else if (armedAt !== 0) {
        armedAt = 0
        discard()
      }
    } else {
      if (smooth > threshold * RELEASE) lastLoud = now
      if (now - lastLoud >= SILENCE_MS || now - speechAt >= MAX_MS || frames > context.sampleRate * 20) finishSpeech()
    }
  }, TICK_MS)

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearHearing()
      abort?.abort()
      if (tickTimer) clearInterval(tickTimer)
      discard()
      try { source.disconnect(); analyser.disconnect() } catch { /* already closed */ }
      void context.close()
      h.onLevel(0)
    },
    setPaused: on => { paused = on; if (on) discard() },
    setGuard: on => { guard = on; if (on) discard() },
  }
}
