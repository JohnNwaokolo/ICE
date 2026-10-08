import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWake } from '../src/lib/wake-parse.mjs'

test('wake parser requires ICE at the start unless already hearing', () => {
  assert.deepEqual(parseWake('ice what time is it', false), { kind: 'command', command: 'what time is it' })
  assert.deepEqual(parseWake('oye ice what time is it', false), { kind: 'command', command: 'what time is it' })
  assert.deepEqual(parseWake('eyes, what is the time', false), { kind: 'command', command: 'what is the time' })
  assert.deepEqual(parseWake('ice', false), { kind: 'wake-only', command: '' })
  assert.deepEqual(parseWake('I see', false), { kind: 'wake-only', command: '' })
  assert.equal(parseWake('the weather is nice today', false).kind, 'ignore')
  assert.deepEqual(parseWake('what time is it in Lagos', true), { kind: 'command', command: 'what time is it in Lagos' })
  assert.equal(parseWake('what time is it in Lagos', false).kind, 'ignore')
  assert.deepEqual(parseWake('um ice open notepad', false), { kind: 'command', command: 'open notepad' })
  assert.deepEqual(parseWake('ICE, open BB Racing', false), { kind: 'command', command: 'open BB Racing' })
})
test('spokenCommand strips ICE for hold-to-talk auto-send', async () => {
  const { spokenCommand } = await import('../src/lib/wake-parse.mjs')
  assert.equal(spokenCommand('ICE open notepad', true), 'open notepad')
  assert.equal(spokenCommand('open notepad', true), 'open notepad')
  assert.equal(spokenCommand('ice', true), '')
  assert.equal(spokenCommand('open notepad', false), '')
})
