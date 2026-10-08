/** Browser Web Speech API. Primary STT — does not call /api/transcribe. */
import { parseWake } from './wake-parse.mjs'
import { releaseMic, startSignalMeter, type SignalMeter } from './audio'

type Rec = {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((ev: RecResultEvent) => void) | null
  onerror: ((ev: { error?: string; message?: string }) => void) | null
  onend: (() => void) | null
  onaudiostart?: (() => void) | null
  onspeechstart?: (() => void) | null
  onspeechend?: (() => void) | null
  onsoundstart?: (() => void) | null
  onsoundend?: (() => void) | null
}
type RecResultEvent = { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }

function SpeechCtor(): (new () => Rec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export function webSpeechAvailable() {
  return Boolean(SpeechCtor())
}

export function speechLang() {
  const langs = [navigator.language, ...(navigator.languages || [])].map(s => String(s || '').toLowerCase())
  if (langs.some(l => l.startsWith('es'))) return 'es-ES'
  return 'en-US'
}

function makeRec(): Rec {
  const Ctor = SpeechCtor()
  if (!Ctor) throw new Error('This browser has no Web Speech API. Use Edge or Chrome on localhost.')
  const rec = new Ctor()
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1
  rec.lang = speechLang()
  return rec
}

function liveTranscript(ev: RecResultEvent) {
  let out = ''
  for (let i = 0; i < ev.results.length; i++) {
    const row = ev.results[i]
    if (row?.[0]?.transcript) out += row[0].transcript + ' '
  }
  return out.replace(/\s+/g, ' ').trim()
}

function finalText(ev: RecResultEvent) {
  let out = ''
  for (let i = ev.resultIndex; i < ev.results.length; i++) {
    const row = ev.results[i]
    if (row?.isFinal && row[0]?.transcript) out += row[0].transcript + ' '
  }
  return out.replace(/\s+/g, ' ').trim()
}

function speechErrorMessage(err: string) {
  if (err === 'not-allowed' || err === 'service-not-allowed') {
    return 'Microphone access denied. Click Allow mic, then Allow in the browser prompt. Use Edge or Chrome on http://127.0.0.1:8787.'
  }
  if (err === 'audio-capture') {
    return 'The microphone could not be captured. Close other apps using the mic, click Allow mic, then Allow in Edge or Chrome.'
  }
  if (err === 'network') {
    return 'Browser speech lost its network. Stay on localhost in Edge or Chrome. ICE will keep listening.'
  }
  if (err === 'language-not-supported') {
    return 'Speech language is not supported. ICE is retrying as English (en-US).'
  }
  if (err === 'no-speech' || err === 'aborted') return ''
  return err ? `Browser speech error: ${err}` : 'Browser speech failed. Use Edge or Chrome on localhost.'
}

function attachMeter(onLevel: (level: number) => void, live: () => boolean): Promise<SignalMeter | null> {
  return startSignalMeter(level => { if (live()) onLevel(level) }).catch(() => null)
}

/** Hold-to-talk: start recognition in this turn (user gesture), then attach the RMS meter. */
export function startWebSpeechHold(onLevel: (level: number) => void, onPartial?: (text: string) => void): { stop: () => Promise<{ text?: string; wav?: Blob }>; cancel: () => void } {
  const rec = makeRec()
  rec.continuous = true
  rec.interimResults = true
  let pieces = ''
  let stopped = false
  let meter: SignalMeter | null = null
  let finishOnce: (() => void) | null = null
  rec.onresult = ev => {
    pieces = liveTranscript(ev) || pieces
    if (pieces) onPartial?.(pieces)
  }
  rec.onerror = ev => {
    const msg = speechErrorMessage(String(ev.error || ''))
    if (msg && !stopped) onPartial?.('')
    if (String(ev.error || '') === 'audio-capture') {
      meter?.stop()
      meter = null
      releaseMic()
    }
    if (msg) (rec as Rec & { _err?: string })._err = msg
  }
  rec.onspeechstart = () => onLevel(0.7)
  rec.onspeechend = () => onLevel(0.12)
  rec.onaudiostart = () => onLevel(0.1)
  rec.onend = () => { finishOnce?.() }
  try { rec.start() }
  catch (e) {
    const msg = e instanceof Error ? e.message : 'Browser speech could not start. Use Edge or Chrome on localhost.'
    throw new Error(msg)
  }
  void attachMeter(onLevel, () => !stopped).then(m => { if (!stopped) meter = m; else m?.stop() })
  const finish = (keep: boolean) => {
    if (stopped) return
    stopped = true
    meter?.stop()
    meter = null
    try { rec.stop() } catch { /* already stopped */ }
    if (!keep) pieces = ''
  }
  return {
    cancel: () => {
      finish(false)
      try { rec.abort() } catch { /* already stopped */ }
    },
    stop: async () => {
      const err = (rec as Rec & { _err?: string })._err
      await new Promise<void>(resolve => {
        let settled = false
        const done = () => { if (settled) return; settled = true; finishOnce = null; resolve() }
        finishOnce = done
        finish(true)
        setTimeout(done, 900)
      })
      try { rec.onresult = null; rec.onerror = null; rec.onend = null } catch { /* already stopped */ }
      const text = pieces.replace(/\s+/g, ' ').trim()
      if (err && !text) throw new Error(err)
      if (!text) throw new Error('No speech was heard. Hold Talk, click Allow if asked, and speak closer to the microphone.')
      onPartial?.(text)
      return { text }
    },
  }
}

export async function startWebSpeechWake(h: {
  onLevel: (level: number) => void
  onHearing: () => void
  onWake: () => void
  onUtterance: (text: string) => void
  onPartial?: (text: string) => void
  canTranscribe?: () => boolean
  onError: (message: string) => void
}): Promise<{ stop: () => void; setPaused: (on: boolean) => void; setGuard: (on: boolean) => void }> {
  let stopped = false
  let paused = false
  let hearing = false
  let rec: Rec | null = null
  let hearingTimer: ReturnType<typeof setTimeout> | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let meter: SignalMeter | null = null
  let meterBlocked = false
  let langFallback = false
  let pendingLive = ''
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastSent = ''

  const clearDebounce = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = null
  }
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
      pendingLive = ''
      h.onPartial?.('')
      if (!stopped && !paused) h.onWake()
    }, 8000)
    h.onHearing()
  }
  const sendCommand = (command: string) => {
    const said = command.replace(/\s+/g, ' ').trim()
    if (!said || said === lastSent) return
    lastSent = said
    pendingLive = ''
    clearDebounce()
    clearHearing()
    h.onPartial?.('')
    h.onUtterance(said)
  }
  const handleText = (raw: string) => {
    if (stopped || paused || !raw) return
    if (h.canTranscribe && !h.canTranscribe()) return
    const hit = parseWake(raw, hearing)
    if (hit.kind === 'ignore') return
    if (hit.kind === 'wake-only') {
      armHearing()
      return
    }
    sendCommand(hit.command)
  }
  const queueSpeech = (raw: string, isFinal: boolean) => {
    if (stopped || paused || !raw) return
    pendingLive = raw
    const hit = parseWake(raw, hearing)
    if (hit.kind === 'ignore') return
    if (hit.kind === 'wake-only') {
      armHearing()
      return
    }
    if (isFinal) {
      handleText(raw)
      return
    }
    clearDebounce()
    debounceTimer = setTimeout(() => handleText(pendingLive || raw), hearing ? 500 : 700)
  }

  const startMeter = () => {
    if (stopped || paused || meterBlocked || meter) return
    void attachMeter(h.onLevel, () => !stopped && !paused).then(m => {
      if (!m) return
      if (stopped || paused || meterBlocked) { m.stop(); return }
      meter = m
    })
  }

  const start = () => {
    if (stopped || paused || rec) return
    rec = makeRec()
    if (langFallback) rec.lang = 'en-US'
    rec.onresult = ev => {
      const live = liveTranscript(ev)
      if (live) h.onPartial?.(live)
      pendingLive = live || pendingLive
      const last = ev.results[ev.results.length - 1]
      if (last && last[0]?.transcript) h.onHearing()
      const text = finalText(ev) || (last?.isFinal ? live : '')
      if (text) queueSpeech(text, true)
      else if (pendingLive) queueSpeech(pendingLive, false)
    }
    rec.onspeechstart = () => { if (!paused) h.onLevel(Math.max(0.55, 0)) }
    rec.onspeechend = () => {
      if (!paused) h.onLevel(0.12)
      if (pendingLive) {
        clearDebounce()
        debounceTimer = setTimeout(() => handleText(pendingLive), 400)
      }
    }
    rec.onsoundstart = () => { if (!paused && !meter) h.onLevel(0.35) }
    rec.onerror = ev => {
      if (stopped || paused) return
      const err = String(ev.error || '')
      if (err === 'audio-capture') {
        meterBlocked = true
        meter?.stop()
        meter = null
        releaseMic()
      }
      if (err === 'language-not-supported' && !langFallback) {
        langFallback = true
        h.onError(speechErrorMessage(err))
        return
      }
      const msg = speechErrorMessage(err)
      if (msg) h.onError(msg)
    }
    rec.onend = () => {
      const leftover = pendingLive
      rec = null
      if (leftover && !stopped && !paused) handleText(leftover)
      if (stopped || paused) return
      restartTimer = setTimeout(start, 220)
    }
    try { rec.start() }
    catch {
      rec = null
      restartTimer = setTimeout(start, 400)
    }
    startMeter()
  }

  start()
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearHearing()
      clearDebounce()
      pendingLive = ''
      if (restartTimer) clearTimeout(restartTimer)
      meter?.stop()
      meter = null
      try { rec?.abort() } catch { /* already stopped */ }
      rec = null
      h.onLevel(0)
      h.onPartial?.('')
    },
    setPaused: on => {
      paused = on
      meter?.setPaused(on)
      if (on) {
        clearHearing()
        clearDebounce()
        pendingLive = ''
        h.onPartial?.('')
        try { rec?.abort() } catch { /* already stopped */ }
        rec = null
      } else if (!stopped) start()
    },
    setGuard: on => {
      meter?.setPaused(on)
      if (on) {
        try { rec?.abort() } catch { /* already stopped */ }
        rec = null
      } else if (!stopped && !paused) start()
    },
  }
}
