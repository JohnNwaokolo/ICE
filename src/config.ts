/** Local-only browser configuration. Provider credentials belong to the server. */
export const BACKEND = 'bridge' as const
export const BRIDGE_HTTP_URL = window.location.origin
export const BRIDGE_WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
export const MODEL = 'qwen3:4b'
export const TTS_ENGINE = 'system' as const
export const KOKORO_VOICE = 'bm_george' as const
export const USE_ELEVENLABS = false
export const FAST_MODE = false
export const WAKE_ENGINE = 'web-speech' as const
// Empty compatibility values for unmounted upstream modules. No VITE_* secrets.
export const env = { anthropicKey: '', elevenKey: '', elevenVoiceId: '', porcupineKey: '' }
export type McpServer = { name: string; label: string; url: string; token?: string; enabled: boolean }
export const MCP_SERVERS: McpServer[] = []
export const activeServers = () => MCP_SERVERS
export const SYSTEM_PROMPT = ''
