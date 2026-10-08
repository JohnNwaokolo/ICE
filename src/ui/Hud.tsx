import { useEffect, useState } from 'react'
import { useStore, accentFor, type Phase } from '../store'

const statusText: Record<Phase, string> = {
  offline: 'LOCAL SERVICE OFFLINE', boot: 'CONNECTING LOCALLY', dormant: 'READY WHEN YOU ARE',
  waking: 'ONLINE', listening: 'HEARING YOU', thinking: 'PROCESSING',
  tooling: 'USING LOCAL TOOL', speaking: 'RESPONDING',
}

function listenStatus(phase: Phase, listen: ReturnType<typeof useStore.getState>['listen']) {
  if (listen === 'muted') return 'MICROPHONE MUTED'
  if (listen === 'need-mic') return 'ALLOW MICROPHONE'
  if (phase === 'speaking') return 'RESPONDING'
  if (phase === 'tooling') return 'USING LOCAL TOOL'
  if (phase === 'thinking') return 'TRANSCRIBING'
  if (listen === 'hearing' || phase === 'listening') return 'HEARING YOU'
  if (listen === 'wake') return 'LISTENING FOR "ICE"'
  return statusText[phase]
}

/** Ice-blue HUD: wake / hearing / responding. Camera stays off until asked. */
export function Hud() {
  const phase = useStore(s => s.phase)
  const listen = useStore(s => s.listen)
  const level = useStore(s => s.level)
  const connected = useStore(s => s.connected)
  const ui = useStore(s => s.ui)
  const caption = useStore(s => s.caption)
  const [now, setNow] = useState(new Date())
  useEffect(() => {const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer)}, [])
  return <div className="hud" style={{['--accent' as string]: accentFor(phase, ui)}}>
    {(['tl','tr','bl','br'] as const).map(at => <div key={at} className={'corner corner-' + at} />)}
    <header className="hud-top">
      <div className="brand"><span className="brand-mark">I.C.E.</span><span className="brand-sub">Local assistant for John</span></div>
    </header>
    <div className="reactor-status"><span className="dot" /><span>{listenStatus(phase, listen)}</span></div>
    {caption && (phase === 'speaking' || phase === 'listening') && <div className="ice-speak-caption" role="status">{caption}</div>}
    <aside className="rail rail-left"><div className="rail-title">SYSTEMS</div>{connected.map(c => <div key={c} className="rail-item"><span className="tick" />{c}</div>)}</aside>
    <aside className="rail rail-right"><div className="rail-title">SIGNAL</div><div className="meter"><div className="meter-fill" style={{height: level * 100 + '%'}} /></div><div className="rail-item mono">{(level * 100).toFixed(0).padStart(3, '0')}%</div></aside>
    <footer className="reactor-footer"><span>{new Intl.DateTimeFormat('en-GB', {timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', second: '2-digit'}).format(now)} WAT</span><span>{new Intl.DateTimeFormat('en-GB', {timeZone: 'Africa/Lagos', dateStyle: 'medium'}).format(now)} · LAGOS</span></footer>
  </div>
}
