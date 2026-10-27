// Seeded random user and engine behaviour against the app, checking what must always hold.
import b4a from 'b4a'
import { App, KeyMsg, chunk, fakeEngine, settle } from './app.mjs'
import { commands } from '../../../dist/product/commands.js'
import { plain } from '../../../dist/product/theme.js'
import { cellWidth } from '../../../dist/product/text.js'

// mulberry32: small, fast, and the same sequence for the same seed on every machine
export function random(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n) => Math.floor(next() * n)
  const pick = (list) => list[int(list.length)]
  const chance = (p) => next() < p

  return { next, int, pick, chance }
}

const NAMED_KEYS = [
  'return',
  'escape',
  'tab',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'space',
  'linefeed'
]
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const TEXT = [
  'hello',
  'fix the tests',
  '@src/app.mjs',
  '!ls -la',
  '!!pwd',
  '/',
  '/model',
  '/help',
  '/chats',
  '/plugins',
  '/fork',
  '/export out.md',
  '/thinking off',
  '/folders read /tmp',
  '/nope',
  'y',
  'n',
  'a',
  '漢字テスト',
  '👩‍💻🚀',
  '\u001b[31mred\u001b[0m',
  'tab\there',
  'x'.repeat(500),
  '   ',
  '1',
  '2',
  '3'
]
const TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'shell',
  'exec',
  'grep',
  'glob',
  'list_dir',
  'web_search',
  'delegate',
  'update_plan',
  'skill',
  'mystery_tool',
  ''
]
const STATES = ['executing', 'completed', 'failed', 'canceled', 'cancelled', 'weird']

function weird(r, depth = 0) {
  const pick = r.int(depth > 2 ? 5 : 9)
  if (pick === 0) {
    return r.pick(TEXT)
  }

  if (pick === 1) {
    return r.int(1e6) - 5e5
  }

  if (pick === 2) {
    return null
  }

  if (pick === 3) {
    return undefined
  }

  if (pick === 4) {
    return r.chance(0.5)
  }

  if (pick === 5) {
    return Array.from({ length: r.int(4) }, () => weird(r, depth + 1))
  }

  return Object.fromEntries(
    Array.from({ length: r.int(4) }, () => [
      r.pick(['path', 'old', 'new', 'content', 'command', 'tasks', 'stdout', 'error', 'x']),
      weird(r, depth + 1)
    ])
  )
}

function transcript(r) {
  const runs = ['run-1', 'run-2', 'run-3']
  return Array.from({ length: r.int(14) }, (_, seq) => {
    const runId = r.pick(runs)
    const kind = r.int(10)
    if (kind === 0) {
      return chunk(seq, 'user-message', { runId: null, userMessage: { text: r.pick(TEXT) } })
    }

    if (kind === 1) {
      return chunk(seq, 'run-request', { runId })
    }

    if (kind === 2) {
      return chunk(seq, 'thinking', { runId, thinking: { text: r.pick(TEXT) } })
    }

    if (kind === 3) {
      return chunk(seq, 'content', { runId, content: { text: r.pick(TEXT) } })
    }

    if (kind === 4) {
      return chunk(seq, 'tool-call', {
        runId,
        toolCall: { name: r.pick(TOOL_NAMES), arguments: weird(r) }
      })
    }

    if (kind === 5) {
      return chunk(seq, 'tool-result', {
        runId,
        toolResult: { name: r.pick(TOOL_NAMES), result: weird(r) }
      })
    }

    if (kind === 6) {
      return chunk(seq, 'approval-request', {
        runId,
        approvalRequest: {
          status: r.pick(['pending', 'approved', 'denied']),
          name: r.pick(TOOL_NAMES),
          arguments: weird(r)
        }
      })
    }

    if (kind === 7) {
      return chunk(seq, 'run-status', {
        runId,
        runStatus: {
          state: r.pick(STATES),
          reason: r.chance(0.3) ? r.pick(['steered', 'boom', '']) : undefined,
          metrics: r.chance(0.5)
            ? { ctxSize: r.int(60000) - 100, totalTokens: r.int(90000) }
            : weird(r)
        }
      })
    }

    if (kind === 8) {
      return chunk(seq, 'sources', {
        runId,
        sources: { sources: [{ title: r.pick(TEXT), url: r.pick(TEXT) }] }
      })
    }

    return chunk(seq, 'attachment', { runId, attachment: { fileName: r.pick(TEXT) } })
  })
}

const chats = (r) =>
  Array.from({ length: r.int(5) }, (_, i) => ({
    id: r.chance(0.7) ? 'chat-1' : `chat-${i}`,
    title: r.pick(TEXT),
    deletedAt: r.chance(0.1) ? 1 : undefined,
    suggestion: r.chance(0.4)
      ? { text: r.pick(TEXT), runId: r.pick(['run-1', 'run-2']) }
      : undefined
  }))

// What the engine and the host can do to the app, besides the person at the keyboard.
const EVENTS = [
  (app, r) =>
    app.options.engine.watches['chunks:' + (app.chatId || 'chat-1')]?.push({
      chunks: transcript(r)
    }),
  (app, r) => app.options.engine.watches.chats?.push({ chats: chats(r) }),
  (app, r) =>
    app.options.engine.watches.status?.push({
      state: r.pick(['joined', 'joining', 'offline', ''])
    }),
  (app, r) =>
    app.options.engine.watches.downloads?.push({
      // name, phase and updatedAt are required by Core's schema; the rest may be missing or odd
      downloads: [
        {
          name: r.pick(['Local', 'Other']),
          phase: r.pick(['queued', 'downloading', 'paused', 'error', 'held']),
          updatedAt: r.int(1e9),
          percentage: r.chance(0.7) ? r.int(120) : undefined,
          downloaded: r.chance(0.5) ? r.int(5000) : undefined,
          total: r.chance(0.5) ? r.int(5000) : undefined,
          error: r.chance(0.2) ? r.pick(TEXT) : undefined
        }
      ]
    }),
  (app, r) => app.update({ type: 'chat.notice', value: r.pick(TEXT) }),
  (app, r) => app.update({ type: 'error', error: new Error(r.pick(TEXT)) }),
  (app) => app.update({ type: 'spin' }),
  (app) => app.update({ type: 'product.poll' }),
  (app, r) =>
    app.update({
      type: 'extensions.reloaded',
      loaded: { extensions: [], problems: r.chance(0.5) ? [r.pick(TEXT)] : [] },
      pluginsChanged: r.chance(0.5)
    })
]

function key(r) {
  const kind = r.int(6)
  if (kind === 0) {
    return new KeyMsg({ name: r.pick(NAMED_KEYS) })
  }

  if (kind === 1) {
    const name = r.pick(LETTERS)
    return new KeyMsg({ name, ctrl: true, sequence: String.fromCharCode(name.charCodeAt(0) - 96) })
  }

  if (kind === 2) {
    return new KeyMsg({ name: r.pick([...LETTERS, '1', '2', '3', 'enter', 'return']), meta: true })
  }

  if (kind === 3) {
    return new KeyMsg({ name: 'tab', shift: true })
  }

  const ch = r.pick([...r.pick(TEXT)])

  return new KeyMsg({ name: ch, sequence: ch })
}

// A real slash command with an argument that may or may not make sense, then enter.
function command(r) {
  const words = [
    '',
    ' on',
    ' off',
    ' 2',
    ' out.md',
    ' /tmp',
    ' read /tmp',
    ' x'.repeat(40),
    ' 漢字'
  ]
  const text = '/' + r.pick(commands).name + r.pick(words)
  const keys = [...text].map((ch) => new KeyMsg({ name: ch, sequence: ch }))

  return [...keys, new KeyMsg({ name: 'return' })]
}

// Keys the screens, pickers and panels answer: moving, toggling, opening, closing.
const SCREEN_KEYS = ['up', 'down', 'space', 'return', 'escape', 'r', 'm', 'n', 'y', 'a', 'q', 'tab']

// One step: mostly keys and typing, then mouse, resizes, pastes and the engine's side.
function step(app, r) {
  const kind = r.int(20)
  if (kind < 6) {
    return [key(r)]
  }

  if (kind < 8) {
    return command(r)
  }

  if (kind === 8) {
    return [new KeyMsg({ name: r.pick(SCREEN_KEYS), sequence: '' })]
  }

  if (kind < 12) {
    return [...r.pick(TEXT)].map((ch) => new KeyMsg({ name: ch, sequence: ch }))
  }

  if (kind === 12) {
    const text = [...(r.pick(TEXT) + '\n' + r.pick(TEXT))]
    return [
      new KeyMsg({ name: 'paste-start' }),
      ...text.map((ch) => new KeyMsg({ name: ch === '\n' ? 'return' : ch, sequence: ch })),
      new KeyMsg({ name: 'paste-end' })
    ]
  }

  if (kind === 13) {
    return [
      {
        type: 'mouse',
        action: r.pick(['wheel', 'press', 'motion', 'release']),
        button: r.pick(['wheelup', 'wheeldown', 'left']),
        x: r.int(220),
        y: r.int(70)
      }
    ]
  }

  if (kind === 14) {
    return [{ type: 'resize', width: 10 + r.int(200), height: 4 + r.int(60) }]
  }

  return [{ event: r.pick(EVENTS) }]
}

// The host's side of the app: shells, files, the editor and the clipboard, each able to fail.
function host(r) {
  const maybe = (name, value) =>
    r.chance(0.2) ? Promise.reject(new Error(`host ${name} failed`)) : Promise.resolve(value)
  return {
    runShell: () =>
      maybe('runShell', { stdout: r.pick(TEXT), stderr: r.pick(TEXT), exitCode: r.int(3) }),
    writeFile: (name) => maybe('writeFile', name),
    readText: () => (r.chance(0.5) ? r.pick(TEXT) : null),
    editExternal: () => maybe('editExternal', r.chance(0.5) ? r.pick(TEXT) : null),
    copyToClipboard: () => maybe('copyToClipboard'),
    gitBranch: () => r.pick(['main', null, 'feat/x']),
    restartCore: () =>
      maybe('restartCore', { engine: fakeEngine(), deviceId: 'aa', meshId: 'account' }),
    // synchronous like the real one: a path that does not resolve throws
    resolveFileAttachment: (path) => {
      if (r.chance(0.5)) {
        throw new Error(`no file at ${path}`)
      }

      return { fileName: String(path), mimeType: 'text/plain', data: b4a.from('x') }
    },
    resolvePastedFile: () => maybe('resolvePastedFile', null),
    post: () => {}
  }
}

// Most engine calls answer as the fakes do; some fail, so every error path gets walked too.
function flaky(engine, r) {
  return new Proxy(engine, {
    get(target, prop) {
      const value = target[prop]
      if (typeof value !== 'function' || prop.endsWith('Watch')) {
        return value
      }

      return (...args) =>
        r.chance(0.1)
          ? Promise.reject(new Error(`engine ${String(prop)} failed`))
          : value.apply(target, args)
    }
  })
}

function label(msg) {
  if (msg.event) {
    return `event ${EVENTS.indexOf(msg.event)}`
  }

  return msg.type === 'key' ? `key ${msg}` : JSON.stringify(msg)
}

const LEAKS = /undefined|NaN|\[object Object\]/

export function check(app) {
  const frame = plain(app.view())
  const rows = frame.split('\n')
  if (rows.length > app.height) {
    return `frame has ${rows.length} rows for a ${app.height}-row terminal`
  }

  const wide = rows.find((row) => cellWidth(row) > app.width)
  if (wide !== undefined) {
    return `row is ${cellWidth(wide)} cells wide for ${app.width}: ${JSON.stringify(wide.slice(0, 80))}`
  }

  const leak = rows.find((row) => LEAKS.test(row))

  return leak === undefined
    ? null
    : `frame shows ${JSON.stringify(leak.match(LEAKS)[0])}: ${JSON.stringify(leak.trim().slice(-160))}`
}

// Runs one seeded session; returns null, or the failure with the steps that led to it.
export async function session(seed, steps) {
  const r = random(seed)
  const engine = fakeEngine()
  const app = new App({
    engine: flaky(engine, r),
    deviceId: 'aa',
    skipSetup: true,
    cwd: '/work',
    ...host(r)
  })
  app.options.engine = engine
  app.width = 40 + r.int(140)
  app.height = 12 + r.int(40)
  const trail = []
  // the replay script reads the app back after a failure
  globalThis.__chaosApp = app
  await settle(app, app.init())
  for (let i = 0; i < steps; i++) {
    for (const msg of step(app, r)) {
      trail.push(label(msg))
      try {
        const out = msg.event ? msg.event(app, r) : app.update(msg)
        // an event that went through update hands back [app, cmd], as update itself does
        const cmd = Array.isArray(out) && out[0] === app ? out[1] : null
        await settle(app, Array.isArray(cmd) || typeof cmd === 'function' ? cmd : null, 2)
      } catch (error) {
        return { seed, step: i, error: error.stack || String(error), trail: trail.slice(-25) }
      }
    }

    let broken
    try {
      broken = check(app)
    } catch (error) {
      broken = `view threw: ${error.stack || error}`
    }

    if (broken) {
      return { seed, step: i, error: broken, trail: trail.slice(-25) }
    }
  }

  return null
}
