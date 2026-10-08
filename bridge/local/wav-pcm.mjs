/** Accept 16 kHz mono PCM16 WAVE, including files with extra RIFF chunks. */

const MAX_PCM = 1_920_000

export function canonicalPcm16Wav(pcm) {
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcm.length, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.length, 40)
  pcm.copy(wav, 44)
  return wav
}

export function pcm16Mono16k(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) return null
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12, fmt = null, data = null
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > wav.length) return null
    if (id === 'fmt ') {
      if (size < 16) return null
      fmt = {
        audio: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      }
    } else if (id === 'data') {
      data = wav.subarray(start, start + size)
    }
    offset = start + size + (size % 2)
  }
  if (!fmt || !data) return null
  if (fmt.audio !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) return null
  if (data.length > MAX_PCM) return null
  if (data.length % 2) return null
  return data
}

export function padPcm16Silence(pcm, ms = 280) {
  const extra = Math.floor(16000 * (Number(ms) || 0) / 1000) * 2
  if (!Buffer.isBuffer(pcm) || extra <= 0) return pcm
  const out = Buffer.alloc(pcm.length + extra * 2)
  pcm.copy(out, extra)
  return out
}

export function whisperLanguageForClip(pcm) {
  const seconds = Buffer.isBuffer(pcm) ? pcm.length / 32000 : 0
  return seconds > 0 && seconds < 2.5 ? 'en' : 'auto'
}
