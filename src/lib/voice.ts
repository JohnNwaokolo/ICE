/** Push-to-talk. Web Speech is primary; PCM clip is only for Gemini/Whisper fallback. */
import { getMic } from './audio'
import { webSpeechAvailable, startWebSpeechHold } from './webSpeech'
export type Recorder = { stop: () => Promise<{ text?: string; wav?: Blob }>; cancel: () => void }
export function encodeWav(samples: Float32Array, sourceRate: number): Blob {
  const rate = 16000
  const count = Math.floor(samples.length * rate / sourceRate)
  const buffer = new ArrayBuffer(44 + count * 2)
  const view = new DataView(buffer)
  const str = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  str(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true)
  str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  str(36, 'data'); view.setUint32(40, count * 2, true)
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * sourceRate / rate)
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * sourceRate / rate)))
    let sum = 0
    for (let j = from; j < to; j++) sum += samples[j]
    const value = Math.max(-1, Math.min(1, sum / (to - from)))
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true)
  }
  return new Blob([buffer], {type: 'audio/wav'})
}

export async function startRecording(onLevel: (level: number) => void): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone needs localhost and a browser with audio recording support.')
  let stream: MediaStream
  try {
    stream = await getMic()
  } catch (error) {
    const name = (error as DOMException).name
    throw new Error(name === 'NotAllowedError'
      ? 'Microphone access denied. Click Allow for this localhost page in your browser, then try again.'
      : name === 'NotFoundError' ? 'No microphone found. Connect or enable a Windows input device.'
      : `Cannot open microphone: ${(error as Error).message}`)
  }
  let context: AudioContext
  try { context = new AudioContext({ sampleRate: 16000 }) }
  catch { context = new AudioContext() }
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  // Widely supported PCM capture keeps microphone data local and avoids a cloud recognizer.
  const processor = context.createScriptProcessor(2048, 1, 1)
  const silent = context.createGain()
  silent.gain.value = 0
  const chunks: Float32Array[] = []
  let stopped = false
  let frames = 0
  processor.onaudioprocess = event => {
    if (stopped) return
    const input = event.inputBuffer.getChannelData(0)
    if (frames < context.sampleRate * 60) {
      const bounded = input.slice(0, Math.max(0, context.sampleRate * 60 - frames))
      chunks.push(bounded)
      frames += bounded.length
    }
    let energy = 0
    for (const value of input) energy += value * value
    onLevel(Math.min(1, Math.sqrt(energy / input.length) * 5))
  }
  source.connect(processor); processor.connect(silent); silent.connect(context.destination)
  const cleanup = () => {
    stopped = true
    processor.onaudioprocess = null
    source.disconnect(); processor.disconnect(); silent.disconnect()
    void context.close()
    onLevel(0)
  }
  return {
    cancel: () => { cleanup(); chunks.length = 0 },
    stop: async () => {
      if (stopped) throw new Error('Recording has already stopped.')
      cleanup()
      const samples = new Float32Array(frames)
      let offset = 0
      for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
      chunks.length = 0
      if (frames < context.sampleRate * 0.2) throw new Error('Recording was too short. Hold Talk for at least a second.')
      return { wav: encodeWav(samples, context.sampleRate) }
    },
  }
}

export async function startHoldToTalk(onLevel: (level: number) => void, onPartial?: (text: string) => void): Promise<Recorder> {
  if (webSpeechAvailable()) return startWebSpeechHold(onLevel, onPartial)
  return startRecording(onLevel)
}
