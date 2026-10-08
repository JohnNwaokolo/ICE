import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, due_at TEXT, done INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation (id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);`)
  const get = (key, fallback) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback }
  const set = (key, value) => db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  const profile = () => get('profile', { owner: 'John Nwaokolo', timezone: 'Africa/Lagos', notes: 'Use concise, clear English. Help with study and JDH Studio when asked; do not invent personal facts or schedules.' })
  function validRecord(input) {
    if (!['memory','task','reminder'].includes(input.kind)) throw new Error('Record kind must be memory, task or reminder.')
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 6000) throw new Error('Record text must contain 1–6000 characters.')
    if (input.due_at && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input.due_at) || !Number.isFinite(Date.parse(input.due_at)))) throw new Error('Reminder time must be ISO 8601 with a timezone, for example 2026-10-01T09:00:00+01:00.')
    if (input.kind === 'reminder' && !input.due_at) throw new Error('A reminder needs a due time.')
    return { kind: input.kind, text: input.text.trim(), due_at: input.due_at ? new Date(input.due_at).toISOString() : null, done: input.done ? 1 : 0 }
  }
  const row = r => r ? { ...r, done: Boolean(r.done) } : null
  const list = () => db.prepare('SELECT * FROM records ORDER BY id DESC').all().map(row)
  const find = id => row(db.prepare('SELECT * FROM records WHERE id=?').get(id))
  return { db, get, set, profile, list, find,
    saveProfile(p) {
      if (typeof p.owner !== 'string' || !p.owner.trim() || p.owner.length > 150 || typeof p.notes !== 'string' || p.notes.length > 10000) throw new Error('Profile needs an owner name and notes of at most 10,000 characters.')
      const clean = { owner: p.owner.trim(), timezone: 'Africa/Lagos', notes: p.notes }; set('profile', clean); return clean
    },
    save(input, id) {
      const r = validRecord(id === undefined ? input : { ...find(id), ...input })
      if (id !== undefined) {
        const old = find(id); if (!old) throw new Error('Record not found.')
        db.prepare('UPDATE records SET kind=?,text=?,due_at=?,done=?,notified=? WHERE id=?').run(r.kind,r.text,r.due_at,r.done,old.due_at === r.due_at ? old.notified : 0,id)
        return find(id)
      }
      const result = db.prepare('INSERT INTO records(kind,text,due_at,done,created_at) VALUES (?,?,?,?,?)').run(r.kind,r.text,r.due_at,r.done,new Date().toISOString())
      return find(Number(result.lastInsertRowid))
    },
    remove(id) { if (!find(id)) throw new Error('Record not found.'); db.prepare('DELETE FROM records WHERE id=?').run(id) },
    history() { return db.prepare('SELECT role,text,created_at FROM conversation ORDER BY id DESC LIMIT 100').all().reverse() },
    log(role, text) { db.prepare('INSERT INTO conversation(role,text,created_at) VALUES(?,?,?)').run(role,text.slice(0,32000),new Date().toISOString()) },
    clearHistory() { db.exec('DELETE FROM conversation') },
    due() { return db.prepare("SELECT * FROM records WHERE kind='reminder' AND done=0 AND notified=0 AND due_at<=?").all(new Date().toISOString()) },
    markNotified(id) { db.prepare('UPDATE records SET notified=1 WHERE id=?').run(id) },
    export() { return { exportedAt: new Date().toISOString(), profile: profile(), records: list(), conversation: this.history() } },
    close() { db.close() },
  }
}
