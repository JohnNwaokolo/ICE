import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Panels } from './ui/Panels'
import { LocalDataPanel, type Health } from './ui/LocalDataPanel'
import { useLocalConfirm } from './ui/LocalConfirm'
import { useStore } from './store'
import { api, establishSession, connect, ask, cancel, watchConnection, watchConfirmation, watchReminder, watchHistoryCleared, watchStatus, answerConfirmation, transcribeClip, type Confirmation } from './lib/bridge'
import { startHoldToTalk, type Recorder } from './lib/voice'
import { webSpeechAvailable, startWebSpeechHold } from './lib/webSpeech'
import { startWakeListen, type WakeListen } from './lib/wake'
import { parseWake } from './lib/wake-parse.mjs'
import { getMic, releaseMic } from './lib/audio'
import { candidateVoices, createSpeaker, currentVoiceName, setVoice } from './lib/tts'
import { describeDevices, describeLocalView, isDeviceAsk, isLookAsk } from './lib/see'
import { cameraStream, holdCamera, releaseCamera, startBuffer, stopBuffer, listCameras, switchCamera, getSelectedCameraId, activeCameraLabel, type CameraChoice } from './lib/camera'
import { disableHands, enableHands } from './lib/hands'
import { Pointer } from './ui/Pointer'
import { GestureGuide } from './ui/GestureGuide'
import './local.css'

class ReactorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false}
  static getDerivedStateFromError() { return {failed: true} }
  render() { return this.state.failed ? <div className="reactor-fallback" aria-label="ICE reactor"><span>I</span></div> : this.props.children }
}
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const id = () => crypto.randomUUID()
const esc = (value: string) => value.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch] as string))
const scheduleAsk = (text: string) => /\b(calendar|schedule|agenda|diary|today|tomorrow|meeting|task|reminder)\b/i.test(text)
type LocalRecord = {id: string | number; kind: string; text: string; due_at: string | null; done?: boolean}
function dueLabel(due: string | null) {
  if (!due) return 'OPEN'
  try { return new Intl.DateTimeFormat('en-GB', {timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(due)) }
  catch { return 'OPEN' }
}
function presentPanel(panel: {id: string; title: string; html: string; hold: 'turn' | 'sticky'}) {
  const next = {...panel, anim: 'materialise' as const, slot: 'wide' as const, accent: 'default' as const}
  useStore.setState(s => ({panels: [...s.panels.filter(p => p.id !== next.id), next].slice(-3)}))
}
async function presentScheduleHud(prompt: string) {
  try {
    const records = await api<LocalRecord[]>('/api/records')
    const items = records.filter(r => r.kind === 'task' || r.kind === 'reminder').slice(0, 8)
    const title = /\btomorrow\b/i.test(prompt) ? 'TOMORROW MARKUP' : /\btoday\b/i.test(prompt) ? 'TODAY MARKUP' : 'LOCAL MARKUP'
    const rows = items.length
      ? items.map(r => `<div class="hud-row"><span class="hud-idx">${esc(dueLabel(r.due_at))}</span><div class="hud-main"><div class="hud-label">${esc(r.text)}</div><div class="hud-sub">${esc(r.kind)}${r.done ? ' · done' : ''}</div></div><span class="hud-tag">${esc(r.kind.toUpperCase())}</span></div>`).join('')
      : '<p class="hud-note">No local tasks or reminders yet. ICE has no cloud calendar.</p>'
    presentPanel({id: 'ice-schedule', title, html: `<div class="hud-rows">${rows}</div>`, hold: 'sticky'})
  } catch { /* HUD is optional; the spoken reply still lands. */ }
}
async function presentClockHud() {
  try {
    const t = await api<{local: string; timezone: string}>('/api/time')
    presentPanel({id: 'ice-clock', title: 'AFRICA / LAGOS', html: `<div class="hud-metric">${esc(t.local)}</div><p class="hud-note">${esc(t.timezone)}</p>`, hold: 'turn'})
  } catch { /* spoken clock reply still lands */ }
}
type Tab = 'conversation' | 'memory' | 'access' | 'settings'

function ConfirmAction({request}: {request: Confirmation}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="confirmation-card" aria-labelledby="confirm-title" onCancel={e => { e.preventDefault(); answerConfirmation(request.id, false) }}>
    <span className="eyebrow">YOUR APPROVAL REQUIRED</span><h2 id="confirm-title">Allow this action?</h2><p>{request.preview}</p>
    <div className="button-row"><button autoFocus onClick={() => answerConfirmation(request.id, false)}>Deny</button><button onClick={() => answerConfirmation(request.id, true)}>Approve once</button></div>
  </dialog>
}

export default function App() {
  const {confirm: confirmLocal, confirmation: localConfirmation} = useLocalConfirm()
  const turns = useStore(s => s.turns)
  const error = useStore(s => s.error)
  const phase = useStore(s => s.phase)
  const listen = useStore(s => s.listen)
  const activeTool = useStore(s => s.activeTool)
  const looking = useStore(s => s.looking)
  const [tab, setTab] = useState<Tab>('conversation')
  const [chatOpen, setChatOpen] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [handsOn, setHandsOn] = useState(false)
  const [cameras, setCameras] = useState<CameraChoice[]>([])
  const [cameraId, setCameraId] = useState(() => getSelectedCameraId())
  const [cameraHint, setCameraHint] = useState('')
  const [draft, setDraft] = useState('')
  const [health, setHealth] = useState<Health | null>(null)
  const [connected, setConnected] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [capture, setCapture] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle')
  const [muted, setMuted] = useState(false)
  const [needMicClick, setNeedMicClick] = useState(false)
  const [micEpoch, setMicEpoch] = useState(0)
  const [heardLive, setHeardLive] = useState('')
  const [spoken] = useState(true)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [lowPower, setLowPower] = useState(true)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [bench, setBench] = useState('')
  const [benchmarking, setBenchmarking] = useState(false)
  const [reminders, setReminders] = useState<{id: string; text: string}[]>([])
  const recorder = useRef<Recorder | null>(null)
  const wake = useRef<WakeListen | null>(null)
  const captureEpoch = useRef(0)
  const releasePending = useRef(false)
  const heardLiveRef = useRef('')
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcription = useRef<AbortController | null>(null)
  const turn = useRef(0)
  const running = useRef(false)
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const benchmarkAudio = useRef<HTMLAudioElement | null>(null)
  const benchmarkEpoch = useRef(0)
  const transcriptEnd = useRef<HTMLDivElement>(null)
  const cameraPreview = useRef<HTMLVideoElement>(null)
  const respondRef = useRef<(text: string) => Promise<void>>(async () => {})
  const report = useCallback((message: string) => useStore.getState().setError(message), [])
  const refresh = useCallback(async () => {
    const h = await api<Health>('/api/health')
    setHealth(h)
    await connect()
    setConnected(true); setReady(true)
    useStore.getState().setConnected([h.brain || (h.provider === 'gemini' ? `Gemini ${h.model}` : h.provider === 'groq' ? `Groq ${h.model}` : h.provider === 'xai' ? `Grok ${h.model}` : h.provider !== 'ollama' ? `${h.provider} ${h.model}` : h.ollama ? `Ollama ${h.model}` : 'Ollama unavailable'), webSpeechAvailable() ? 'Browser speech' : h.stt ? (h.sttEngine || 'Local speech') : 'Voice setup needed', 'Wake: say ICE', 'PC webcam'])
    if (!running.current) useStore.getState().setPhase('dormant')
  }, [])

  const releaseResources = useCallback(() => {
    turn.current++; captureEpoch.current++
    cancel(); recorder.current?.cancel(); transcription.current?.abort(); speaker.current?.cancel()
    if (recordingTimer.current) clearTimeout(recordingTimer.current)
  }, [])

  useEffect(() => {
    let mounted = true
    watchConnection(state => {
      if (!mounted) return
      setConnected(state !== 'lost')
      if (state === 'lost') report('Local connection lost. Use Settings → Refresh status / reconnect.')
    })
    watchConfirmation(request => { if (mounted) setConfirmation(request) })
    watchReminder(request => { if (mounted) setReminders(items => items.some(item => item.id === request.id) ? items : [...items, request]) })
    watchHistoryCleared(() => {
      if (!mounted) return
      turn.current++; running.current = false; setBusy(false); speaker.current?.cancel()
      useStore.getState().clearScreen('transcript'); useStore.getState().setPhase('dormant')
    })
    watchStatus(message => {
      if (!mounted) return
      report(message)
      void api<Health>('/api/health').then(h => { if (mounted) setHealth(h) }).catch(() => {})
    })
    useStore.getState().setPhase('boot')
    void establishSession().then(async () => {
      const history = await api<{role: string; text: string}[]>('/api/history')
      if (!mounted) return
      useStore.getState().clearScreen('transcript')
      for (const message of history) useStore.getState().pushTurn({id: id(), role: message.role === 'user' ? 'user' : 'jarvis', text: message.text})
      await refresh()
    }).catch(e => {
      if (mounted) { report(errorText(e)); useStore.getState().setPhase('offline') }
    })
    const updateVoices = () => {
      const list = candidateVoices()
      setVoices(list)
      if (!voiceId && list[0]) {
        setVoiceId(list[0].voiceURI)
        setVoice(list[0].voiceURI)
      }
      useStore.getState().setVoice(currentVoiceName())
    }
    updateVoices()
    window.speechSynthesis?.addEventListener('voiceschanged', updateVoices)
    return () => {
      mounted = false; releaseResources(); wake.current?.stop(); wake.current = null; releaseMic()
      window.speechSynthesis?.removeEventListener('voiceschanged', updateVoices)
    }
  }, [refresh, report, releaseResources])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const load = async () => {
      try {
        const list = await listCameras()
        if (cancelled) return
        setCameras(list)
        if (list.some(c => c.phoneLink) && !list.some(c => !c.phoneLink)) {
          setCameraHint('Only Phone Link is listed. ICE uses the laptop webcam by default. Enable the PC camera, or pick a device in Settings.')
        } else if (list.length && list.every(c => !c.label || c.label === 'Camera')) {
          setCameraHint('Camera names appear after you allow the camera or click Refresh cameras. Auto uses the PC webcam, not Phone Link.')
        } else {
          const using = list.find(c => c.deviceId === getSelectedCameraId()) || list.find(c => !c.phoneLink)
          setCameraHint(using ? `Ready: ${using.option}` : '')
        }
      } catch (e) {
        if (!cancelled) setCameraHint(errorText(e))
      }
    }
    void load()
    const onChange = () => { void load() }
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
    }
  }, [ready])

  useEffect(() => { transcriptEnd.current?.scrollIntoView({block: 'nearest'}) }, [turns, tab])

  useEffect(() => {
    if (!ready) return
    if (muted) {
      wake.current?.stop(); wake.current = null
      releaseMic()
      useStore.getState().setListen('muted')
      return
    }
    if (!webSpeechAvailable() && !health?.stt) {
      useStore.getState().setListen('off')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        wake.current?.stop()
        const listener = await startWakeListen({
          onLevel: level => {
            if (!running.current) useStore.getState().setLevel(level)
          },
          onHearing: () => {
            if (!running.current) {
              useStore.getState().setListen('hearing')
              useStore.getState().setPhase('listening')
            }
          },
          onWake: () => {
            if (!running.current) {
              useStore.getState().setListen('wake')
              useStore.getState().setPhase('dormant')
            }
          },
          onUtterance: text => { void respondRef.current(text) },
          onPartial: text => { if (!running.current) { heardLiveRef.current = text; setHeardLive(text); if (text) useStore.getState().setCaption(text) } },
          canTranscribe: () => !running.current && !muted,
          transcribe: async (wav, signal) => {
            useStore.getState().setPhase('thinking')
            const result = await transcribeClip(wav, signal)
            if (!result.text?.trim()) throw new Error('No clear speech was detected.')
            return result.text.trim()
          },
          onError: message => { if (!cancelled) report(message) },
        })
        if (cancelled) { listener.stop(); return }
        wake.current = listener
        setNeedMicClick(false)
        if (!running.current) {
          useStore.getState().setListen('wake')
          useStore.getState().setPhase('dormant')
        }
        if (!webSpeechAvailable()) report('This window has no Web Speech API. Open ICE in Edge or Chrome with Start-Jarvis.cmd.')
      } catch (e) {
        if (cancelled) return
        const message = errorText(e)
        if (/denied|Allow/i.test(message)) {
          setNeedMicClick(true)
          useStore.getState().setListen('need-mic')
        }
        report(message)
      }
    })()
    return () => { cancelled = true; wake.current?.stop(); wake.current = null }
  }, [ready, muted, health?.stt, report, micEpoch])

  useEffect(() => {
    if (!cameraOn) {
      stopBuffer()
      disableHands()
      setHandsOn(false)
      useStore.getState().setLooking(null)
      useStore.getState().setGestures(false)
      return
    }
    let held = false
    let cancelled = false
    void (async () => {
      try {
        await holdCamera()
        if (cancelled) { releaseCamera(); return }
        held = true
        startBuffer()
        const node = cameraPreview.current
        if (node) {
          node.srcObject = cameraStream()
          await node.play().catch(() => {})
        }
        useStore.getState().setLooking('live')
      } catch (e) {
        if (!cancelled) { setCameraOn(false); report(errorText(e)) }
      }
    })()
    return () => {
      cancelled = true
      if (cameraPreview.current) cameraPreview.current.srcObject = null
      if (held) { stopBuffer(); releaseCamera() }
      useStore.getState().setLooking(null)
    }
  }, [cameraOn, report])

  useEffect(() => {
    if (!cameraOn || !handsOn) {
      disableHands()
      useStore.getState().setGestures(false)
      return
    }
    let cancelled = false
    void enableHands().then(() => {
      if (!cancelled) useStore.getState().setGestures(true)
    }).catch(e => {
      if (!cancelled) { setHandsOn(false); report(errorText(e)) }
    })
    return () => { cancelled = true; disableHands(); useStore.getState().setGestures(false) }
  }, [cameraOn, handsOn, report])

  const stop = () => {
    turn.current++; captureEpoch.current++; benchmarkEpoch.current++
    running.current = false
    cancel(); speaker.current?.cancel(); speaker.current = null
    recorder.current?.cancel(); recorder.current = null
    transcription.current?.abort(); transcription.current = null
    benchmarkAudio.current?.pause(); benchmarkAudio.current = null
    if (recordingTimer.current) clearTimeout(recordingTimer.current)
    wake.current?.setPaused(false)
    wake.current?.setGuard(false)
    setCapture('idle'); setBusy(false); setBenchmarking(false)
    useStore.getState().setPhase('dormant'); useStore.getState().setActiveTool(null); useStore.getState().setLevel(0); useStore.getState().setCaption('')
    setConfirmation(null)
  }

  const respond = async (text: string) => {
    const said = text.trim()
    if (!said) return
    if (!ready) {
      report('Local session is not ready. Reopen ICE with Start-Jarvis.cmd.')
      return
    }
    stop()
    report('')
    const mine = ++turn.current
    const stale = () => mine !== turn.current
    running.current = true; setBusy(true); setDraft(''); setHeardLive(said); heardLiveRef.current = ''
    const s = useStore.getState()
    s.clearScreen('panels')
    s.pushTurn({id: id(), role: 'user', text: said}); s.setPhase('speaking'); s.setCaption(said)
    if (scheduleAsk(said)) void presentScheduleHud(said)
    const responseId = id()
    let started = false
    let spokenSoFar = ''
    const spk = spoken ? createSpeaker(message => {if (!stale()) report(message)}) : null
    speaker.current = spk
    void import('./lib/kokoro').then(k => k.load()).catch(() => {})
    wake.current?.setGuard(true)
    const pulse = setInterval(() => {
      if (stale() || !speaker.current) return
      s.setLevel(speaker.current.level())
    }, 40)
    try {
      if (isDeviceAsk(said) && !isLookAsk(said)) {
        const answer = await describeDevices()
        if (stale()) return
        s.pushTurn({id: responseId, role: 'jarvis', text: answer}); started = true
        s.setPhase('speaking'); s.setCaption(answer.slice(-220)); spk?.say(answer)
        await spk?.end()
      } else if (isLookAsk(said)) {
        s.setLooking('looking')
        const answer = await describeLocalView(cameraOn)
        if (stale()) return
        s.pushTurn({id: responseId, role: 'jarvis', text: answer}); started = true
        s.setPhase('speaking'); s.setCaption(answer.slice(-220)); spk?.say(answer)
        await spk?.end()
      } else {
      await ask(said, {
        onText: delta => {
          if (stale()) return
          const visible = delta.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '')
          if (!visible.trim()) return
          if (!started) { s.pushTurn({id: responseId, role: 'jarvis', text: ''}); started = true }
          s.appendToLastTurn(visible); s.setActiveTool(null); s.setPhase('speaking')
          spokenSoFar += visible
          s.setCaption(spokenSoFar.slice(-220))
          spk?.push(visible)
        },
        onTool: name => {
          if (stale()) return
          s.setActiveTool(name); s.setPhase('tooling')
          if (name === 'get_time') void presentClockHud()
          else if (name === 'list_records') void presentScheduleHud(said)
          else if (name === 'open_app' || name === 'open_website' || name === 'open_path') {
            presentPanel({id: 'ice-open', title: 'OPEN', html: '<p class="hud-note">Opening on this PC. Secrets and Gmail stay blocked.</p>', hold: 'turn'})
          }
        },
      })
      }
      if (stale()) return
      await spk?.end()
    } catch (e) {
      if (!stale() && (e as Error).name !== 'AbortError') report(errorText(e))
      spk?.cancel()
    } finally {
      clearInterval(pulse)
      wake.current?.setGuard(false)
      if (!cameraOn) useStore.getState().setLooking(null)
      if (!stale()) {
        running.current = false; setBusy(false); s.setPhase('dormant'); s.setActiveTool(null); s.setLevel(0); s.setCaption(''); speaker.current = null
        if (useStore.getState().listen !== 'muted' && useStore.getState().listen !== 'need-mic' && useStore.getState().listen !== 'off') s.setListen('wake')
      }
    }
  }
  respondRef.current = respond

  const finishRecording = async () => {
    const rec = recorder.current
    if (!rec) {
      if (capture === 'starting' || releasePending.current) {
        releasePending.current = true
        return
      }
      wake.current?.setPaused(false)
      if (!transcription.current) { captureEpoch.current++; setCapture('idle'); useStore.getState().setPhase('dormant') }
      return
    }
    recorder.current = null
    releasePending.current = false
    if (recordingTimer.current) clearTimeout(recordingTimer.current)
    const mine = captureEpoch.current
    setCapture('transcribing'); useStore.getState().setPhase('thinking')
    const controller = new AbortController()
    transcription.current = controller
    try {
      const heard = await rec.stop().catch(() => ({ text: heardLiveRef.current, wav: undefined as Blob | undefined }))
      if (mine !== captureEpoch.current) return
      let text = heard.text?.trim() || heardLiveRef.current.trim()
      const hit = parseWake(text, true)
      if (hit.kind === 'wake-only') throw new Error('Say your request, then release Hold.')
      text = hit.command || text
      if (!text && heard.wav) {
        const result = await transcribeClip(heard.wav, controller.signal)
        const fromClip = parseWake(result.text?.trim() || '', true)
        if (fromClip.kind === 'wake-only') throw new Error('Say your request, then release Hold.')
        text = fromClip.command || result.text?.trim() || ''
      }
      if (!text) throw new Error('No clear speech was detected. Try again closer to your microphone.')
      setDraft(''); setHeardLive(''); heardLiveRef.current = ''
      setCapture('idle'); transcription.current = null
      wake.current?.setPaused(false)
      await respond(text)
      return
    } catch (e) { if (mine === captureEpoch.current && (e as Error).name !== 'AbortError') report(errorText(e)) }
    finally {
      if (mine === captureEpoch.current) { setCapture('idle'); useStore.getState().setPhase('dormant'); transcription.current = null; wake.current?.setPaused(false); releasePending.current = false }
    }
  }

  const beginRecording = async () => {
    if (!ready || (capture !== 'idle' && !releasePending.current)) return
    if (!webSpeechAvailable() && !health?.stt) { report('Speech is not ready in this browser. Use Edge or Chrome on localhost.'); return }
    report('')
    wake.current?.setPaused(true)
    releasePending.current = false
    const mine = ++captureEpoch.current
    setCapture('starting')
    try {
      const rec = webSpeechAvailable()
        ? startWebSpeechHold(
          level => useStore.getState().setLevel(level),
          text => { heardLiveRef.current = text; setHeardLive(text); setDraft(text); useStore.getState().setCaption(text) },
        )
        : await startHoldToTalk(
          level => useStore.getState().setLevel(level),
          text => { heardLiveRef.current = text; setHeardLive(text); setDraft(text); useStore.getState().setCaption(text) },
        )
      if (mine !== captureEpoch.current) { rec.cancel(); wake.current?.setPaused(false); return }
      recorder.current = rec; setCapture('recording'); useStore.getState().setPhase('listening'); useStore.getState().setListen('hearing')
      recordingTimer.current = setTimeout(() => { void finishRecording() }, 60000)
      if (releasePending.current) void finishRecording()
    } catch (e) {
      if (mine === captureEpoch.current) { setCapture('idle'); report(errorText(e)); useStore.getState().setPhase('dormant'); wake.current?.setPaused(false) }
    }
  }

  const testVoice = async () => {
    speaker.current?.cancel()
    const spk = createSpeaker(report); speaker.current = spk
    spk.say('Hello John. Your offline voice is ready.'); await spk.end()
  }
  const benchmark = async () => {
    if (benchmarking || !await confirmLocal('Download the optional Kokoro speech model from Hugging Face and test it locally? This uses internet data but no paid API.')) return
    const mine = ++benchmarkEpoch.current
    setBenchmarking(true); setBench('Loading the optional model. The first download can take a few minutes…')
    try {
      const kokoro = await import('./lib/kokoro')
      await kokoro.load()
      if (mine !== benchmarkEpoch.current) return
      if (!kokoro.isReady()) throw new Error(kokoro.lastError || 'Kokoro is unavailable on this device.')
      const start = performance.now()
      const url = await kokoro.speak('Hello John. Your local ICE is ready.')
      if (!url) throw new Error(kokoro.lastError || 'Kokoro could not generate speech.')
      if (mine !== benchmarkEpoch.current) { URL.revokeObjectURL(url); return }
      const seconds = (performance.now() - start) / 1000
      const audio = new Audio(url); benchmarkAudio.current = audio
      audio.onloadedmetadata = () => { if (mine === benchmarkEpoch.current) setBench(`Kokoro: ${seconds.toFixed(1)}s generation for ${audio.duration.toFixed(1)}s audio. Installed Windows voice remains the default.`) }
      audio.onended = () => URL.revokeObjectURL(url)
      audio.onerror = () => {URL.revokeObjectURL(url); if (mine === benchmarkEpoch.current) setBench('Kokoro playback failed. Installed offline voice remains available.')}
      await audio.play()
    } catch (e) {
      if (mine === benchmarkEpoch.current) { setBench('Kokoro unavailable: ' + errorText(e) + ' Using the installed offline voice.'); await testVoice() }
    } finally { if (mine === benchmarkEpoch.current) setBenchmarking(false) }
  }

  return <main className={lowPower ? 'jarvis-local low-power circle-first' : 'jarvis-local circle-first'}>
    <div className="reactor-region"><ReactorBoundary><Scene lowPower={lowPower} /></ReactorBoundary></div>
    <Hud />
    <div className="ice-hud-stage"><Panels /></div>
    {(needMicClick || capture !== 'idle' || phase === 'listening' || listen === 'wake' || listen === 'hearing') && <div className="ice-listen-caption" role="status">{needMicClick ? 'Click Allow mic, then Allow in the browser prompt' : capture === 'starting' ? 'Allow microphone' : capture === 'transcribing' || phase === 'thinking' ? 'Transcribing' : heardLive ? heardLive : capture === 'recording' || phase === 'listening' ? 'Hearing you' : 'Listening for ICE'}</div>}
    {(cameraOn || looking === 'looking') && <div className="hands-live" role="status">{looking === 'looking' ? 'LOOKING · LOCAL' : 'CAMERA LIVE · LOCAL'}{activeCameraLabel() ? ` · ${activeCameraLabel()}` : ''}</div>}
    {cameraOn && <video ref={cameraPreview} className="ice-camera-preview" autoPlay playsInline muted aria-label="Local camera preview" />}
    {cameraOn && handsOn && <Pointer />}
    {cameraOn && handsOn && <GestureGuide live />}
    {chatOpen && <aside className={'local-console' + (tab === 'conversation' ? ' overlay-chat' : ' overlay-card') + (turns.length ? ' has-talk' : '')} aria-label="ICE controls">
      <div className="console-heading"><span>ICE · BLUE ICE</span><button type="button" className="fold-chat" onClick={() => setChatOpen(false)}>Hide chat</button><span className={connected ? 'local-ready' : 'local-offline'}>{!connected ? '○ DISCONNECTED' : health?.provider !== 'ollama' ? '● CLOUD SELECTED' : '● LOCAL'}</span></div>
      <nav className="local-tabs" aria-label="Workspace">
        {(['conversation', 'memory', 'access', 'settings'] as const).map(value => <button aria-current={tab === value ? 'page' : undefined} className={tab === value ? 'selected' : ''} key={value} onClick={() => setTab(value)}>{value === 'access' ? 'Approvals' : value[0].toUpperCase() + value.slice(1)}</button>)}
      </nav>
      {error && <div className="local-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => report('')}>×</button></div>}
      {health && health.provider !== 'ollama' && <div className="local-error" role="status"><span>Cloud provider enabled: {health.provider} / {health.model}. Messages leave this PC and API charges may apply.</span></div>}
      {health?.notice && <div className="local-error" role="status"><span>{health.notice}</span></div>}
      {reminders.map(reminder => <div className="reminder-alert" role="status" key={reminder.id}><span>Reminder: {reminder.text}</span><button onClick={() => setReminders(items => items.filter(item => item.id !== reminder.id))}>Dismiss</button></div>)}
      {tab === 'conversation' ? <>
        <div className="local-transcript" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
          {turns.length === 0 && <div className="welcome"><span className="eyebrow">AT YOUR SERVICE</span><p>Say <b>ICE</b> and your request. Chat stays folded so the circle can fill the screen. Camera is off until you turn it on or ask ICE to look.</p></div>}
          {turns.map(message => <article className={'message message-' + message.role} key={message.id}><span className="message-role">{message.role === 'user' ? 'YOU' : 'ICE'}</span><div className="message-text">{message.text || '…'}</div></article>)}
          {busy && <div className="working-note" role="status">{confirmation ? 'Waiting for your confirmation' : activeTool ? 'Using ' + activeTool.replaceAll('_', ' ') : phase === 'thinking' ? (health?.provider === 'ollama' ? 'Answering…' : 'Waiting for the selected cloud provider…') : 'Responding…'}</div>}
          <div ref={transcriptEnd} />
        </div>
      </> : <div className="panel-scroll">
        <LocalDataPanel tab={tab} health={health} refresh={refresh} report={report} />
        {tab === 'settings' && <section className="voice-settings local-panel">
          <h2>Voice & visuals</h2>
          <label>Installed offline voice<select value={voiceId} onChange={e => {setVoiceId(e.target.value); setVoice(e.target.value); useStore.getState().setVoice(currentVoiceName())}}><option value="">Default installed voice</option>{voices.map(voice => <option value={voice.voiceURI} key={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select></label>
          <p className="subtle">{voices.length ? voices.length + ' installed offline voice(s) available.' : 'No local voices found. Use Edge or install a Windows speech voice.'}</p>
          <div className="button-row"><button onClick={() => void testVoice()}>Test voice</button><button disabled={benchmarking} onClick={() => void benchmark()}>{benchmarking ? 'Testing Kokoro…' : 'Benchmark optional Kokoro'}</button><button onClick={stop}>Stop audio</button></div>
          {bench && <p className="subtle" role="status">{bench}</p>}
          <label className="check-label"><input type="checkbox" checked={lowPower} onChange={e => setLowPower(e.target.checked)} />Low-power visuals (default on — keeps the ice HUD off the iGPU limit)</label>
          <label>Camera<select value={cameraId} onChange={async e => {
            const next = e.target.value
            setCameraId(next)
            try {
              const source = await switchCamera(next)
              const node = cameraPreview.current
              if (source && node) node.srcObject = cameraStream()
              const using = cameras.find(c => c.deviceId === next) || cameras.find(c => next === 'auto' && !c.phoneLink)
              setCameraHint(using ? `Using ${using.option}` : next === 'auto' ? 'Auto uses the PC webcam, not Phone Link.' : '')
            } catch (err) {
              report(errorText(err))
              setCameraHint(errorText(err))
              if (cameraOn) setCameraOn(false)
            }
          }}>
            <option value="auto">Auto · PC webcam</option>
            {cameras.map(cam => <option value={cam.deviceId} key={cam.deviceId}>{cam.option}</option>)}
          </select></label>
          <div className="button-row"><button type="button" onClick={async () => {
            try {
              const list = await listCameras({ probe: true })
              setCameras(list)
              if (!list.length) setCameraHint('No camera was found. Enable the laptop webcam, then click Refresh cameras.')
              else if (list.every(c => c.phoneLink) && cameraId === 'auto') setCameraHint('Only Phone Link is listed. ICE uses the laptop webcam by default. Enable the PC camera, or pick a device here.')
              else setCameraHint(list.length + ' camera(s) listed. Auto uses the PC webcam unless you pick another.')
            } catch (e) { setCameraHint(errorText(e)); report(errorText(e)) }
          }}>Refresh cameras</button></div>
          {cameraHint && <p className="subtle" role="status">{cameraHint}</p>}
          <label className="check-label"><input type="checkbox" checked={cameraOn} onChange={e => setCameraOn(e.target.checked)} />Camera (off until you ask ICE to look, or turn this on). Uses the PC webcam, not Phone Link, unless you pick another.</label>
          <label className="check-label"><input type="checkbox" checked={handsOn} disabled={!cameraOn} onChange={e => setHandsOn(e.target.checked)} />Hand overlay (optional, needs camera, default off)</label>
          <p className="subtle">Say ICE to talk. Mute stops the microphone. Camera never starts automatically. Click Allow mic after refresh if the browser asks. Groq and Grok keys go in backend.env only. Kokoro is optional. Automatic paid Claude failover is disabled.</p>
        </section>}
      </div>}
      <footer className="console-footer"><span>{health?.provider || 'OLLAMA'} · {health?.model || 'QWEN3:4B'}</span><button disabled={!ready || busy || turns.length === 0} onClick={async () => {
        if (!await confirmLocal('Clear your conversation history from this PC? Saved memories, tasks and reminders stay available.')) return
        stop()
        void api('/api/history', {method: 'DELETE', body: JSON.stringify({confirm: true})}).then(() => useStore.getState().clearScreen('transcript')).catch(e => report(errorText(e)))
      }}>Clear conversation</button><span>{health && health.provider !== 'ollama' ? 'CLOUD CHARGES MAY APPLY' : 'ZERO API COST'}</span></footer>
    </aside>}
    <form className="ice-dock" onSubmit={e => {e.preventDefault(); void respond(draft)}} aria-label="ICE bar">
      <button type="button" className={chatOpen ? 'recording' : ''} onClick={() => setChatOpen(open => !open)} aria-expanded={chatOpen}>{chatOpen ? 'Hide chat' : 'Chat'}</button>
      <input className="ice-dock-input" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask ICE…" maxLength={12000} disabled={!ready || capture === 'transcribing'} aria-label="Message ICE" />
      <button className="send-button" type="submit" disabled={!ready || !draft.trim() || busy || capture !== 'idle'}>Send</button>
      {needMicClick && <button type="button" className="recording" onClick={() => {
        void (async () => {
          try {
            await getMic()
            setNeedMicClick(false)
            setMuted(false)
            setMicEpoch(n => n + 1)
            report('')
          } catch (e) {
            setNeedMicClick(true)
            useStore.getState().setListen('need-mic')
            report(errorText(e))
          }
        })()
      }}>Allow mic</button>}
      <button type="button" className={muted ? '' : 'recording'} disabled={!ready} onClick={() => setMuted(on => !on)} aria-label={muted ? 'Unmute microphone and listen for ICE' : 'Mute microphone'}>{muted ? 'Mic muted' : 'Mic on'}</button>
      <button type="button" className={cameraOn ? 'recording' : ''} onClick={() => setCameraOn(on => !on)} aria-pressed={cameraOn} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}>{cameraOn ? 'Camera on' : 'Camera off'}</button>
      <button type="button" className={handsOn ? 'recording' : ''} disabled={!cameraOn} onClick={() => setHandsOn(on => !on)} aria-pressed={handsOn} title="Optional MediaPipe hand overlay. Default off on this laptop.">{handsOn ? 'Hands on' : 'Hands'}</button>
      <button type="button" className={capture === 'recording' ? 'recording' : ''} disabled={!ready || muted || capture === 'transcribing'} onPointerDown={e => {if (capture !== 'idle') return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); void beginRecording()}} onPointerUp={e => {e.preventDefault(); if (capture === 'starting' || !recorder.current) releasePending.current = true; void finishRecording()}} onPointerCancel={() => stop()} aria-label="Hold to talk fallback">{capture === 'recording' ? 'Release' : 'Hold'}</button>
      <button type="button" onClick={stop} disabled={!busy && capture === 'idle' && !benchmarking && !speaker.current}>Stop</button>
    </form>
    {error && !chatOpen && <div className="ice-dock-error" role="alert">{error}</div>}
    {confirmation && <ConfirmAction key={confirmation.id} request={confirmation} />}
    {localConfirmation}
  </main>
}
