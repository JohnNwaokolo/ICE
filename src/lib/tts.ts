/** Installed offline voices only. No external TTS requests or automatic fallback. */
type Speaker = {push: (delta: string) => void; say: (text: string) => void; end: () => Promise<void>; cancel: () => void; level: () => number}
let selected = ''
let speaking = ''
let began = 0
export const diag = {engine: 'system', spoken: 0, started: 0, failures: 0, lastError: '', nativeBroken: false, rescued: 0, voice: '', lastText: ''}
export const speakingSince = () => began
export const speakingNow = () => speaking
export function candidateVoices(): SpeechSynthesisVoice[] {
  if (!('speechSynthesis' in window)) return []
  const score = (v: SpeechSynthesisVoice) => {
    const n = v.name.toLowerCase()
    if (/zira/.test(n)) return 0
    if (/eva|aria|jenny|sara|hazel|susan/.test(n)) return 1
    if (/(natural|neural)/.test(n) && /^en/i.test(v.lang)) return 2
    if (/david/.test(n)) return 80
    if (/^en/i.test(v.lang)) return 10
    return 20
  }
  return speechSynthesis.getVoices().filter(v => v.localService).sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
}
export function setVoice(name: string) { selected = name }
export function currentVoiceName() { return candidateVoices().find(v => v.voiceURI === selected)?.name || candidateVoices()[0]?.name || 'No installed offline voice' }
export function cycleVoice() {
  const voices = candidateVoices()
  const index = voices.findIndex(v => v.voiceURI === selected)
  selected = voices[(index + 1) % voices.length]?.voiceURI || ''
  return currentVoiceName()
}
export function createSpeaker(onError?: (message: string) => void): Speaker {
  let buffer = ''
  const queue: string[] = []
  let active = false
  let cancelled = false
  let ended = false
  let resolveEnd: (() => void) | null = null
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const settle = () => { if (ended && !active && !queue.length) resolveEnd?.() }
  const fail = (message: string) => {
    diag.failures++; diag.lastError = message
    queue.length = 0; buffer = ''; active = false; speaking = ''
    onError?.(message); settle()
  }
  const pump = () => {
    if (active || cancelled) return
    const text = queue.shift()
    if (!text) { settle(); return }
    const voices = candidateVoices()
    const voice = voices.find(v => v.voiceURI === selected) || voices[0]
    if (!voice) { fail('No installed offline voice is available in this browser. Install a Windows speech voice or use Edge. Text replies still work.'); return }
    active = true
    const speakSystem = () => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 1.05
      diag.engine = 'system'; diag.spoken++; diag.voice = voice.name; diag.lastText = text
      utterance.onstart = () => { if (!cancelled) { diag.started++; speaking = text; began = Date.now() } }
      const done = () => { clearTimeout(watchdog); active = false; speaking = ''; if (!cancelled) pump() }
      utterance.onend = done
      utterance.onerror = event => {
        clearTimeout(watchdog)
        if (cancelled || event.error === 'canceled' || event.error === 'interrupted') { done(); return }
        fail(`Offline voice failed (${event.error}). Try Test voice in Settings.`)
      }
      watchdog = setTimeout(() => { if (!cancelled && active) { speechSynthesis.cancel(); fail('Speech playback timed out. Check your Windows output device, then test the voice again.') } }, 45000)
      speechSynthesis.speak(utterance)
    }
    void import('./kokoro').then(async k => {
      if (cancelled) return
      if (!k.isReady()) { speakSystem(); return }
      const url = await k.speak(text)
      if (!url || cancelled) { if (!cancelled) speakSystem(); return }
      diag.engine = 'kokoro'; diag.spoken++; diag.voice = 'Kokoro bm_george'; diag.lastText = text
      const audio = new Audio(url)
      audio.onplay = () => { if (!cancelled) { diag.started++; speaking = text; began = Date.now() } }
      const done = () => { URL.revokeObjectURL(url); clearTimeout(watchdog); active = false; speaking = ''; if (!cancelled) pump() }
      audio.onended = done
      audio.onerror = () => { URL.revokeObjectURL(url); speakSystem() }
      watchdog = setTimeout(() => { if (!cancelled && active) { audio.pause(); fail('Speech playback timed out. Check your Windows output device, then test the voice again.') } }, 45000)
      await audio.play()
    }).catch(() => { if (!cancelled) speakSystem() })
  }
  const enqueue = (text: string) => {
    const clean = text
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/<\/?think>/gi, ' ')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[`*_#]/g, '')
      .trim()
    if (!clean || cancelled) return
    // Bounded utterances prevent native engines stalling on long responses.
    for (const part of clean.match(/.{1,220}(?:\s|$)|.{1,220}/g) || [clean]) queue.push(part.trim())
    pump()
  }
  return {
    push: delta => {
      if (cancelled) return
      buffer += delta
      buffer = buffer.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      if (/<think>/i.test(buffer) && !/<\/think>/i.test(buffer)) return
      buffer = buffer.replace(/^[\s\S]*?<\/think>/i, ' ')
      let match: RegExpMatchArray | null
      while ((match = buffer.match(/^([\s\S]*?[.!?…](?:\s|$))/))) {
        enqueue(match[1]); buffer = buffer.slice(match[1].length)
      }
      // Start audio on the first words — do not wait for a full sentence.
      if (!queue.length && !active && (match = buffer.match(/^([\s\S]{8,}?[,;:](?:\s|$))/) || buffer.match(/^([\s\S]{10,}?\s)/))) {
        enqueue(match[1]); buffer = buffer.slice(match[1].length)
      }
    },
    say: enqueue,
    end: () => {
      ended = true
      enqueue(buffer); buffer = ''
      return new Promise<void>(resolve => { resolveEnd = resolve; if (cancelled) resolve(); else settle() })
    },
    cancel: () => {
      cancelled = true; ended = true; active = false
      buffer = ''; queue.length = 0; clearTimeout(watchdog); speaking = ''
      if ('speechSynthesis' in window) speechSynthesis.cancel()
      resolveEnd?.()
    },
    level: () => {
      if (!active) return 0
      const t = Date.now() / 1000
      return 0.22 + 0.55 * (0.5 + 0.5 * Math.sin(t * 12.4) * Math.sin(t * 3.2))
    },
  }
}
