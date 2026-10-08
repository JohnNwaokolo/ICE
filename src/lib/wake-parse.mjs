/** Wake-word parse only. Kept as plain JS so unit tests do not load the mic graph. */
const WAKE = /(?:(?:hey|ok|okay|hi|hello|yo|oye|hola)\s+)?\b(?:ice(?:d|y)?|i\s*[. ]\s*c\s*[. ]\s*e|eyes|ayes|i\s+see)\b/ig

export function parseWake(text, hearing) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return { kind: 'ignore', command: '' }
  let last = null
  const re = new RegExp(WAKE.source, 'ig')
  let match
  while ((match = re.exec(raw))) last = match
  if (last) {
    const rest = raw.slice(last.index + last[0].length).replace(/^[\s,.:;!?-]+/, '').trim()
    return rest ? { kind: 'command', command: rest } : { kind: 'wake-only', command: '' }
  }
  if (hearing) return { kind: 'command', command: raw }
  return { kind: 'ignore', command: '' }
}

/** Hold-to-talk is already a request: strip a leading ICE if present, else send the whole transcript. */
export function spokenCommand(text, alreadyListening = false) {
  const hit = parseWake(text, alreadyListening)
  if (hit.kind === 'ignore') return alreadyListening ? String(text || '').trim() : ''
  if (hit.kind === 'wake-only') return ''
  return hit.command
}
