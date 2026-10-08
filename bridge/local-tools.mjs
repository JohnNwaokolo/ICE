import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Jarvis')
  : join(homedir(), '.jarvis')
export const MEMORY_FILE = join(DATA_DIR, 'memory.json')

export const APPROVED_TARGETS = Object.freeze({
  visual_studio_code: {
    label: 'Visual Studio Code',
    kind: 'app',
    command: join(homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    args: [],
  },
  notepad: {
    label: 'Notepad',
    kind: 'app',
    command: join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'notepad.exe'),
    args: [],
  },
  calculator: {
    label: 'Calculator',
    kind: 'app',
    command: 'calc.exe',
    args: [],
  },
  github: { label: 'GitHub', kind: 'website', url: 'https://github.com' },
  youtube: { label: 'YouTube', kind: 'website', url: 'https://www.youtube.com' },
  whatsapp_web: {
    label: 'WhatsApp Web',
    kind: 'website',
    url: 'https://web.whatsapp.com',
  },
  jdh_studio: { label: 'JDH Studio', kind: 'website', url: 'https://jdhstudio.co' },
})

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_lagos_time',
      description: 'Get the real current date and time in Africa/Lagos.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_approved_targets',
      description: 'List apps and websites ICE is allowed to open.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_approved_target',
      description:
        'Open one item from the approved target list. Never open a target not in the list.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: Object.keys(APPROVED_TARGETS),
            description: 'The approved target identifier.',
          },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_local_memory',
      description: 'Read the user-approved local ICE memory.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
]

export function getLagosTime(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    dateStyle: 'full',
  }).format(now)
  const time = new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(now)
  return { date, time, timeZone: 'Africa/Lagos', iso: now.toISOString() }
}

export async function readMemory() {
  try {
    const data = JSON.parse(await readFile(MEMORY_FILE, 'utf8'))
    return Array.isArray(data.items) ? data.items : []
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return []
  }
}

export async function writeMemory(items) {
  if (!Array.isArray(items) || items.length > 100) {
    throw new Error('Memory must contain at most 100 entries.')
  }
  const normalized = items.map((item) => {
    if (
      !item ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      item.text.length > 2000 ||
      (item.id !== undefined && typeof item.id !== 'string')
    ) {
      throw new Error('Each memory entry needs text between 1 and 2,000 characters.')
    }
    return { id: item.id || randomUUID(), text: item.text.trim() }
  })
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(MEMORY_FILE, `${JSON.stringify({ items: normalized }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return normalized
}

function launch(command, args, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function executeTool(name, args = {}, options = {}) {
  switch (name) {
    case 'get_lagos_time':
      return getLagosTime(options.now)
    case 'list_approved_targets':
      return Object.entries(APPROVED_TARGETS).map(([id, target]) => ({
        id,
        label: target.label,
        kind: target.kind,
      }))
    case 'get_local_memory':
      return readMemory()
    case 'open_approved_target': {
      if (typeof args.target !== 'string' || !Object.hasOwn(APPROVED_TARGETS, args.target)) {
        throw new Error('That app or website is not approved to open.')
      }
      const target = APPROVED_TARGETS[args.target]
      if (target.kind === 'website') {
        await launch('rundll32.exe', ['url.dll,FileProtocolHandler', target.url], options.spawn)
      } else {
        await launch(target.command, target.args, options.spawn)
      }
      return { opened: true, label: target.label }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}