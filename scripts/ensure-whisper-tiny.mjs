import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'runtime', 'whisper', 'ggml-tiny.bin')
const SIZE = 77691713
const SHA = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
const URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin'

if (existsSync(DEST) && statSync(DEST).size === SIZE) {
  console.log('OK ggml-tiny.bin multilingual')
  process.exit(0)
}

const tmp = DEST + '.tmp'
const response = await fetch(URL, { redirect: 'follow' })
if (!response.ok || !response.body) throw new Error('Could not download official ggml-tiny.bin (' + response.status + ').')
await pipeline(response.body, createWriteStream(tmp))
const digest = createHash('sha256').update(readFileSync(tmp)).digest('hex')
if (statSync(tmp).size !== SIZE || digest !== SHA) {
  try { unlinkSync(tmp) } catch {}
  throw new Error('multilingual tiny checksum mismatch. Expected ' + SIZE + ' bytes / ' + SHA)
}
renameSync(tmp, DEST)
writeFileSync(join(ROOT, 'runtime', 'whisper', 'source-tiny-model.json'), JSON.stringify({ url: URL, size: SIZE, sha256: SHA, languages: 'multilingual' }, null, 2))
console.log('Downloaded official multilingual ggml-tiny.bin')
