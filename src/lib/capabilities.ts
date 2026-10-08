import { api } from './bridge'
export type Capabilities = { stt: boolean; tts: boolean }
let current: Capabilities = {stt: false, tts: false}
let probed = false
export const caps = () => current
export const capabilitiesProbed = () => probed
export async function probeCapabilities(): Promise<Capabilities> {
  try {
    const health = await api<{stt: boolean}>('/api/health')
    current = {stt: health.stt, tts: false}
  } finally { probed = true }
  return current
}
export const engineLabel = () => 'Local Whisper + installed Windows voice'
