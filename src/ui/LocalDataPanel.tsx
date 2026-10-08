import { useEffect, useState } from 'react'
import { api } from '../lib/bridge'
import { webSpeechAvailable } from '../lib/webSpeech'
import { useLocalConfirm } from './LocalConfirm'

export type Health = {ok: boolean; model: string; provider: string; brain?: string; alternates?: {groq?: boolean; xai?: boolean}; ollama: boolean; ollamaService?: boolean; downloadPercent?: number; stt: boolean; sttEngine?: string | null; error?: string; notice?: string; timezone: string; cloudMemoryShared?: boolean; geminiTts?: boolean; ttsEngine?: string}
type Profile = {owner: string; timezone: string; notes: string}
type RecordItem = {id: string; kind: 'memory' | 'task' | 'reminder'; text: string; due_at: string | null; done: boolean; created_at: string}
type Approvals = {availableApps: {id: string; label: string}[]; approvedApps: string[]; approvedSites: string[]; projectRoot: string | null}
type Props = {tab: 'memory' | 'access' | 'settings'; health: Health | null; refresh: () => Promise<void>; report: (error: string) => void}

export function LocalDataPanel({tab, health, refresh, report}: Props) {
  const {confirm, confirmation} = useLocalConfirm()
  const [profile, setProfile] = useState<Profile>({owner: 'John', timezone: 'Africa/Lagos', notes: ''})
  const [records, setRecords] = useState<RecordItem[]>([])
  const [approvals, setApprovals] = useState<Approvals>({availableApps: [], approvedApps: [], approvedSites: [], projectRoot: ''})
  const [kind, setKind] = useState<RecordItem['kind']>('memory')
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [sites, setSites] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stale = false
    const load = async () => {
      try {
        const [p, r, a] = await Promise.all([api<Profile>('/api/profile'), api<RecordItem[]>('/api/records'), api<Approvals>('/api/approvals')])
        if (stale) return
        setProfile(p); setRecords(r); setApprovals(a); setSites(a.approvedSites.join('\n'))
      } catch (e) { if (!stale) report((e as Error).message) }
    }
    void load()
    return () => { stale = true }
  }, [tab, report]) // Refresh saved records when a panel is revisited.

  const perform = async (fn: () => Promise<void>, message: string) => {
    setBusy(true); setNotice('')
    try { await fn(); setNotice(message) }
    catch (e) { report((e as Error).message) }
    finally { setBusy(false) }
  }

  const saveRecord = () => perform(async () => {
    if (!text.trim()) throw new Error('Write the memory, task or reminder first.')
    if (kind === 'reminder' && !due) throw new Error('Choose a reminder date and time in Lagos.')
    const body = {kind, text: text.trim(), due_at: due ? new Date(due + ':00+01:00').toISOString() : null}
    await api(editing ? '/api/records/' + encodeURIComponent(editing) : '/api/records', {method: editing ? 'PUT' : 'POST', body: JSON.stringify(body)})
    setRecords(await api<RecordItem[]>('/api/records'))
    setText(''); setDue(''); setEditing(null)
  }, 'Saved locally.')

  return <div className="local-panel">
    {tab === 'memory' && <>
      <h2>Local memory</h2>
      <p>Facts you choose to save, tasks and reminders. Your profile and saved memories help ICE personalise replies.</p>
      <form onSubmit={e => {e.preventDefault(); void saveRecord()}} className="local-form">
        <label>Type<select value={kind} onChange={e => setKind(e.target.value as RecordItem['kind'])}>
          <option value="memory">Memory</option><option value="task">Task</option><option value="reminder">Reminder</option>
        </select></label>
        <label>{editing ? 'Edit saved entry' : 'New entry'}<textarea value={text} onChange={e => setText(e.target.value)} maxLength={4000} placeholder="For example: I prefer concise answers." required /></label>
        {(kind === 'reminder' || kind === 'task') && <label>Due in Africa/Lagos (UTC+1)<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} required={kind === 'reminder'} /></label>}
        <div className="button-row"><button disabled={busy} type="submit">{editing ? 'Save changes' : 'Save locally'}</button>{editing && <button type="button" onClick={() => {setEditing(null); setText(''); setDue('')}}>Cancel edit</button>}</div>
      </form>
      <div className="saved-entries">{records.length === 0 && <p className="subtle">No entries yet.</p>}
        {records.map(record => <article className="saved-entry" key={record.id}>
          <span className="entry-kind">{record.kind}{record.done ? ' · completed' : ''}</span>
          <p>{record.text}</p>
          {record.due_at && <time>{new Intl.DateTimeFormat('en-GB', {timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short'}).format(new Date(record.due_at))} WAT</time>}
          <div className="button-row">
            <button onClick={() => {setEditing(record.id); setKind(record.kind); setText(record.text); setDue(record.due_at ? new Date(new Date(record.due_at).getTime() + 3600000).toISOString().slice(0, 16) : '')}}>Edit</button>
            {record.kind !== 'memory' && <button disabled={busy} onClick={() => void perform(async () => {
              await api('/api/records/' + encodeURIComponent(record.id), {method: 'PUT', body: JSON.stringify({done: !record.done})})
              setRecords(await api<RecordItem[]>('/api/records'))
            }, 'Updated.')}>{record.done ? 'Reopen' : 'Complete'}</button>}
            <button disabled={busy} className="danger" onClick={async () => {
              if (!await confirm('Delete this saved ' + record.kind + '?\n\n' + record.text)) return
              void perform(async () => {await api('/api/records/' + encodeURIComponent(record.id), {method: 'DELETE', body: JSON.stringify({confirm: true})}); setRecords(await api<RecordItem[]>('/api/records'))}, 'Deleted.')
            }}>Delete</button>
          </div>
        </article>)}
      </div>
      <button disabled={busy} onClick={() => void perform(async () => {
        const data = await api('/api/export')
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}))
        const a = document.createElement('a'); a.href = url; a.download = 'ice-local-memory.json'; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      }, 'Local export downloaded.')}>Export local data</button>
      <p className="subtle">Reminders appear while ICE is running. Keep the app open for reminders.</p>
    </>}
    {tab === 'access' && <>
      <h2>Approved apps & websites</h2>
      <p>ICE opens apps, files and HTTPS sites you name on this PC immediately. Secret files and Gmail stay blocked.</p>
      <form onSubmit={e => {e.preventDefault(); void perform(async () => {
        const siteList = sites.split('\n').map(s => s.trim()).filter(Boolean)
        for (const value of siteList) {
          let parsed: URL
          try { parsed = new URL(value) } catch { throw new Error('Use a complete HTTPS website URL: ' + value) }
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Approved websites must use HTTPS without embedded credentials.')
        }
        const result = await api<Approvals>('/api/approvals', {method: 'PUT', body: JSON.stringify({apps: approvals.approvedApps, sites: siteList, projectRoot: approvals.projectRoot || ''})})
        setApprovals(result); setSites(result.approvedSites.join('\n'))
      }, 'Your approvals are saved.') }} className="local-form">
        <fieldset><legend>Available apps</legend>{approvals.availableApps.length === 0 && <p>No supported apps detected yet.</p>}
        {approvals.availableApps.map(app => <label className="check-label" key={app.id}><input type="checkbox" checked={approvals.approvedApps.includes(app.id)} onChange={e => setApprovals(a => ({...a, approvedApps: e.target.checked ? [...a.approvedApps, app.id] : a.approvedApps.filter(id => id !== app.id)}))} />{app.label}</label>)}</fieldset>
        <label>Approved website URLs · one per line<textarea value={sites} onChange={e => setSites(e.target.value)} placeholder="https://example.com/" rows={4} spellCheck={false} /></label>
        <label>Project folder for read-only file tools<input value={approvals.projectRoot || ''} onChange={e => setApprovals(a => ({...a, projectRoot: e.target.value}))} placeholder="Optional local project folder" /></label>
        <button disabled={busy} type="submit">Save explicit approvals</button>
      </form>
      <p className="subtle">Sending messages, publishing, deleting files, arbitrary commands and account integrations are unavailable in this first version.</p>
    </>}
    {tab === 'settings' && <>
      <h2>John's local ICE</h2>
      <dl className="health-grid"><dt>Active brain</dt><dd>{health?.brain || `${health?.provider || 'ollama'} ${health?.model || 'qwen3:4b'}`}</dd><dt>Model</dt><dd>{health?.model || 'qwen3:4b'}</dd><dt>Provider</dt><dd>{health?.provider === 'gemini' ? `Gemini · ${health.model}` : health?.provider === 'groq' ? `Groq · ${health.model}` : health?.provider === 'xai' ? `Grok · ${health.model}` : health && health.provider !== 'ollama' ? health.provider + ' · cloud enabled in server configuration' : `Ollama · ${health?.model || 'qwen3:4b'}`}</dd><dt>Model service</dt><dd>{health?.provider === 'gemini' ? `Gemini ${health.model} selected` : health?.provider === 'groq' ? 'Groq selected' : health?.provider === 'xai' ? 'Grok (xAI) selected' : health && health.provider !== 'ollama' ? 'Cloud provider selected explicitly' : health?.ollama ? 'Ready' : health?.ollamaService ? 'Running - model download needed' : 'Unavailable — start Ollama'}</dd><dt>Transcription</dt><dd>{webSpeechAvailable() ? 'Browser Web Speech (Edge/Chrome) · primary' : health?.stt ? (health.sttEngine || 'Local speech fallback') : 'Not ready — use Edge or Chrome'}</dd><dt>Camera</dt><dd>PC webcam by default · off until look or toggle</dd><dt>Automatic cloud fallback</dt><dd>Gemini first. On HTTP 400/503/404, ICE tries Groq ({health?.alternates?.groq ? 'key set' : 'waiting for GROQ_API_KEY'}) then Grok ({health?.alternates?.xai ? 'key set' : 'waiting for XAI_API_KEY / GROK_API_KEY'}), then local qwen3:4b. Never Claude.</dd><dt>Runtime API cost</dt><dd>{health && health.provider !== 'ollama' ? 'Messages leave this PC' : 'Zero'}</dd><dt>Time zone</dt><dd>Africa/Lagos · UTC+1</dd></dl>
      {health && health.provider !== 'ollama' && <p className="inline-error">Messages are sent to the selected cloud provider. {health.cloudMemoryShared ? 'Saved profile and memory sharing is enabled.' : 'Saved profile and memory sharing is disabled.'}</p>}
      {health?.notice && <p className="inline-error" role="status">{health.notice}</p>}
      {health?.error && <p className="inline-error">{health.error}</p>}
      <button disabled={busy} onClick={() => void perform(refresh, 'Status refreshed.')}>Refresh status / reconnect</button>
      <form className="local-form" onSubmit={e => {e.preventDefault(); void perform(async () => {
        const p = await api<Profile>('/api/profile', {method: 'PUT', body: JSON.stringify({...profile, timezone: 'Africa/Lagos'})})
        setProfile(p)
      }, 'Profile saved locally.')}}>
        <label>Your name<input value={profile.owner} onChange={e => setProfile(p => ({...p, owner: e.target.value}))} required maxLength={100} /></label>
        <label>Preferences & background<textarea value={profile.notes} onChange={e => setProfile(p => ({...p, notes: e.target.value}))} placeholder="How you want ICE to help" maxLength={8000} rows={4} /></label>
        <button disabled={busy} type="submit">Save profile</button>
      </form>
      <p className="subtle">The microphone starts when ICE launches so it can hear “ICE”. Camera stays off until you turn it on or ask ICE to look. Mute from the bottom bar anytime. Speech is transcribed on this PC with a small local Whisper model.</p>
    </>}
    {notice && <p className="saved-notice" role="status">{notice}</p>}
    {confirmation}
  </div>
}
