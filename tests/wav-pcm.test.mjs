import test from 'node:test'
import assert from 'node:assert/strict'
import { pcm16Mono16k, canonicalPcm16Wav, padPcm16Silence, whisperLanguageForClip } from '../bridge/local/wav-pcm.mjs'

test('accepts 16 kHz mono PCM16 WAVE with an extra LIST chunk', () => {
  const pcm = Buffer.alloc(3200)
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8000, i)
  const inner = canonicalPcm16Wav(pcm)
  const list = Buffer.alloc(12)
  list.write('LIST', 0)
  list.writeUInt32LE(4, 4)
  list.write('INFO', 8)
  const extra = Buffer.concat([inner.subarray(0, 36), list, inner.subarray(36)])
  extra.writeUInt32LE(extra.length - 8, 4)
  const parsed = pcm16Mono16k(extra)
  assert.ok(parsed)
  assert.equal(parsed.length, pcm.length)
  assert.equal(pcm16Mono16k(Buffer.from('not wav')), null)
})
test('pads silence without changing speech samples; short clips prefer English decode', () => {
  const pcm = Buffer.alloc(3200)
  pcm.writeInt16LE(12345, 0)
  const padded = padPcm16Silence(pcm, 250)
  assert.equal(padded.length, pcm.length + 16000)
  assert.equal(padded.readInt16LE(8000), 12345)
  assert.equal(whisperLanguageForClip(Buffer.alloc(32000)), 'en')
  assert.equal(whisperLanguageForClip(Buffer.alloc(32000 * 4)), 'auto')
})
