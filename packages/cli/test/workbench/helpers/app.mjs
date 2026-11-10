// The dashboard under test with a fake engine: shared by the product tests.
import { plain } from '../../../dist/product/theme.js'
import { cellWidth } from '../../../dist/lib/terminal/text.js'
import { productApp } from '../../../dist/product/app.js'

const chordAliases = { esc: 'escape', return: 'enter' }

export class KeyMsg {
  constructor(key) {
    Object.assign(this, { type: 'key', ctrl: false, meta: false, shift: false }, key)
  }

  toString() {
    const parts = []
    if (this.ctrl) {
      parts.push('ctrl')
    }

    if (this.meta) {
      parts.push('alt')
    }

    if (this.shift && this.name?.length > 1) {
      parts.push('shift')
    }

    parts.push(this.name === 'return' ? 'enter' : this.name)

    return parts.join('+')
  }

  is(...chords) {
    return chords.some((c) => (chordAliases[c] || c) === String(this))
  }
}
export const tui = {
  KeyMsg,
  quit: () => ({ type: 'quit' }),
  tick: () => () => Promise.resolve(null),
  batch: (...cmds) => cmds.flat().filter(Boolean),
  style: { width: cellWidth }
}
export const App = productApp(tui)

export function feed() {
  const queue = [],
    waiting = []
  return {
    push(value) {
      const w = waiting.shift()
      if (w) {
        w({ value, done: false })
      } else {
        queue.push(value)
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          queue.length
            ? Promise.resolve({ value: queue.shift(), done: false })
            : new Promise((r) => waiting.push(r)),
        return: () => Promise.resolve({ done: true })
      }
    }
  }
}

export function fakeEngine(overrides = {}) {
  const calls = [],
    watches = {}
  const watch = (name) => () => (watches[name] ||= feed())
  const engine = {
    calls,
    watches,
    account: async () => ({ meshId: 'account' }),
    meshStatusWatch: watch('status'),
    modelDownloadsWatch: watch('downloads'),
    getConfig: () => Promise.resolve({ onboardingCompleted: true }),
    setConfig: (input) => {
      calls.push(['setConfig', input])
      return Promise.resolve()
    },
    listMeshes: () => Promise.resolve({ meshes: [{ meshId: 'account', account: true }] }),
    listModels: () => Promise.resolve({ models: [model('Local')] }),
    listMembers: () => Promise.resolve({ members: [] }),
    listDevices: () => Promise.resolve({ devices: [] }),
    listAgents: () => Promise.resolve({ agents: [] }),
    diagnostics: () => Promise.resolve({}),
    ...overrides
  }

  return engine
}

export const model = (name, extra = {}) => ({
  name,
  type: 'completion',
  taskType: 'llm',
  isCached: true,
  expectedSize: 1000,
  ...extra
})

// Runs commands like bare-tui's Program, without timers.
export async function settle(app, cmd, rounds = 40) {
  const pending = []
  const run = (c) => {
    if (!c) return
    if (Array.isArray(c)) {
      return c.forEach(run)
    }

    pending.push(
      Promise.resolve(c()).then((msg) => {
        if (msg) {
          run(app.update(msg)[1])
        }
      })
    )
  }
  run(cmd)
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

export async function boot({ engine: overrides, ...options } = {}) {
  const engine = fakeEngine(overrides)
  const app = new App({ engine, deviceId: 'aa', skipSetup: true, ...options })
  app.width = options.width || 100
  app.height = options.height || 34
  await settle(app, app.init())
  return { app, engine }
}

export const press = (app, name, extra = {}) =>
  app.update(new KeyMsg({ name, sequence: name.length === 1 ? name : '', ...extra }))[1]
export const screen = (app) => plain(app.view())
