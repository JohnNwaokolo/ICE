import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVED_TARGETS,
  executeTool,
  getLagosTime,
  TOOL_DEFINITIONS,
} from './local-tools.mjs'

test('Lagos time uses the Africa/Lagos timezone and current instant', () => {
  const value = getLagosTime(new Date('2026-10-01T12:00:00.000Z'))
  assert.equal(value.timeZone, 'Africa/Lagos')
  assert.equal(value.iso, '2026-10-01T12:00:00.000Z')
  assert.match(value.time, /1:00:00 pm/i)
})

test('the model receives only the fixed, approved target identifiers', () => {
  const schema = TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === 'open_approved_target',
  )
  assert.deepEqual(schema.function.parameters.properties.target.enum, Object.keys(APPROVED_TARGETS))
  assert.ok(Object.values(APPROVED_TARGETS).every((target) => target.kind === 'app' || target.url.startsWith('https://')))
})

test('unapproved targets are rejected without launching a process', async () => {
  let launched = false
  await assert.rejects(
    executeTool('open_approved_target', { target: 'https://example.com' }, {
      spawn: () => { launched = true },
    }),
    /not approved/,
  )
  assert.equal(launched, false)
})

test('approved app launch never enables a shell', async () => {
  let invocation
  const fakeSpawn = (command, args, options) => {
    invocation = { command, args, options }
    const child = {
      once(event, listener) {
        if (event === 'spawn') queueMicrotask(listener)
        return this
      },
      unref() {},
    }
    return child
  }
  const result = await executeTool('open_approved_target', { target: 'notepad' }, { spawn: fakeSpawn })
  assert.equal(result.opened, true)
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.command, APPROVED_TARGETS.notepad.command)
})