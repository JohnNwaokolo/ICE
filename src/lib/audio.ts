/**
 * A single shared microphone stream. Opening the mic more than once causes
 * Chrome to drop the earlier stream, so wake-word and hold-to-talk share this.
 * Camera is never requested here.
 */

let stream: MediaStream | null = null

export async function getMic(): Promise<MediaStream> {
  if (stream && stream.active) return stream
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  })
  stream.getTracks().forEach(track => {
    track.onended = () => { if (stream && !stream.active) stream = null }
  })
  return stream
}

export function releaseMic() {
  stream?.getTracks().forEach(track => track.stop())
  stream = null
}

export function micLive() {
  return Boolean(stream?.active)
}

export type SignalMeter = {
  stop: () => void
  setPaused: (on: boolean) => void
}

/** Local AnalyserNode on the shared mic stream. Drives HUD SIGNAL from RMS. */
export async function startSignalMeter(onLevel: (level: number) => void): Promise<SignalMeter> {
  const live = await getMic()
  let context: AudioContext
  try { context = new AudioContext({ sampleRate: 16000 }) }
  catch { context = new AudioContext() }
  await context.resume()
  const source = context.createMediaStreamSource(live)
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.35
  source.connect(analyser)
  const time = new Float32Array(analyser.fftSize)
  let stopped = false
  let paused = false
  let smooth = 0
  let raf = 0
  let lastEmit = 0

  const tick = () => {
    if (stopped) return
    raf = requestAnimationFrame(tick)
    if (paused) return
    analyser.getFloatTimeDomainData(time)
    let sum = 0
    for (let i = 0; i < time.length; i++) sum += time[i] * time[i]
    const rms = Math.sqrt(sum / time.length)
    smooth += (rms - smooth) * 0.45
    const now = performance.now()
    if (now - lastEmit < 50) return
    lastEmit = now
    onLevel(Math.min(1, Math.max(0, smooth * 10)))
  }
  tick()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(raf)
      try { source.disconnect(); analyser.disconnect() } catch { /* already closed */ }
      void context.close()
      onLevel(0)
    },
    setPaused: on => {
      paused = on
      if (on) {
        smooth = 0
        onLevel(0)
      }
    },
  }
}
