import test from 'node:test'
import assert from 'node:assert/strict'
import { runOllamaTurn, SYSTEM_PROMPT } from './ollama-agent.mjs'

function response(...messages) {
  const body = messages.map((message) => JSON.stringify({ message })).join('\n') + '\n'
  return new Response(body, { status: 200 })
}

test('system prompt forbids numbered lists and think-aloud', () => {
  assert.match(SYSTEM_PROMPT, /Never use numbered lists/)
  assert.match(SYSTEM_PROMPT, /Do not explain your reasoning/)
  assert.match(SYSTEM_PROMPT, /Do not mention Africa\/Lagos/)
})

test('streams an Ollama reply and returns history for the next turn', async () => {
  const deltas = []
  const result = await runOllamaTurn({
    prompt: 'Hello',
    history: [{ role: 'user', content: 'Earlier' }],
    signal: new AbortController().signal,
    onText: (delta) => deltas.push(delta),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      assert.equal(body.model, 'qwen3:4b')
      assert.equal(body.stream, true)
      assert.equal(body.think, false)
      return response({ content: 'Local ' }, { content: 'reply.' })
    },
  })
  assert.equal(result.text, 'Local reply.')
  assert.equal(deltas.join(''), 'Local reply.')
  assert.deepEqual(result.history.slice(-2), [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Local reply.' },
  ])
})

test('executes only a named local tool, then streams the final answer', async () => {
  let requests = 0
  const tools = []
  const result = await runOllamaTurn({
    prompt: 'What time is it in Lagos?',
    signal: new AbortController().signal,
    onTool: (name) => tools.push(name),
    execute: async (name, args) => {
      assert.equal(name, 'get_lagos_time')
      assert.deepEqual(args, {})
      return { timeZone: 'Africa/Lagos', time: '1:00 pm' }
    },
    fetchImpl: async (_url, options) => {
      requests += 1
      if (requests === 1) {
        return response({
          content: '',
          tool_calls: [{ id: 'call-1', function: { name: 'get_lagos_time', arguments: '{}' } }],
        })
      }
      const body = JSON.parse(options.body)
      assert.equal(body.messages.at(-1).role, 'tool')
      assert.match(body.messages.at(-1).content, /Africa\/Lagos/)
      return response({ content: 'It is 1:00 pm in Lagos.' })
    },
  })
  assert.equal(requests, 2)
  assert.deepEqual(tools, ['get_lagos_time'])
  assert.equal(result.text, 'It is 1:00 pm in Lagos.')
})

test('reports a missing Ollama model clearly', async () => {
  await assert.rejects(
    runOllamaTurn({
      prompt: 'Hello',
      signal: new AbortController().signal,
      fetchImpl: async () => new Response('model not found', { status: 404 }),
    }),
    /ollama pull qwen3:4b/,
  )
})

test('caps tool execution and does not silently switch providers', async () => {
  let requests = 0
  let executions = 0
  await assert.rejects(
    runOllamaTurn({
      prompt: 'Loop',
      maxToolRounds: 1,
      signal: new AbortController().signal,
      execute: async () => { executions += 1; return {} },
      fetchImpl: async () => {
        requests += 1
        return response({
          content: '',
          tool_calls: [{ id: `call-${requests}`, function: { name: 'get_lagos_time', arguments: '{}' } }],
        })
      },
    }),
    /tool-call limit/,
  )
  assert.equal(requests, 2)
  assert.equal(executions, 0)
})