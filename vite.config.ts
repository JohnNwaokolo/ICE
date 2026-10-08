import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function mediapipeWasm() {
  const copy = () => {
    const src = join('node_modules', '@mediapipe', 'tasks-vision', 'wasm')
    const dest = join('public', 'mediapipe')
    mkdirSync(dest, { recursive: true })
    for (const name of readdirSync(src)) copyFileSync(join(src, name), join(dest, name))
  }
  return { name: 'mediapipe-wasm', buildStart: copy }
}

export default defineConfig({
  plugins: [react(), mediapipeWasm()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
