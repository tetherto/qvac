import type { Agent } from '../lib/types.js'
export interface ExtensionContext {
  send(text: string): void
  insert(text: string): void
  notice(text: string): void
  show(title: string, lines: string[]): void
  readonly agent: { id: string; name: string; model: string | null | undefined } | null
  readonly model: string | null
  readonly chatId: string | null
  readonly cwd: string | undefined
}
export interface ExtensionCommand {
  name: string
  description?: string
  run(ctx: ExtensionContext, args: string): unknown | Promise<unknown>
}
export interface Extension {
  name?: string
  commands?: ExtensionCommand[]
  keys?: Record<string, (ctx: ExtensionContext) => unknown | Promise<unknown>>
  footer?: (ctx: ExtensionContext) => string
  theme?: Record<string, unknown>
}
export interface ExtensionEntry {
  name: string
  extension: Extension
}
export interface LoadedExtensions {
  extensions: ExtensionEntry[]
  problems: string[]
}
export interface ExtensionMessage {
  type: string
  text?: string
  title?: string
  lines?: string[]
  value?: unknown
  extension?: string
  error?: unknown
}
interface Environment {
  post(message: ExtensionMessage): void
  read(): { agent: Agent | null; chatId: string | null; cwd?: string | undefined }
}
interface Binding {
  chord: string
  extension: string
  keys: NonNullable<Extension['keys']>
}
import { palette } from './theme.js'

// Extension code only ever sees this facade; every action reaches the app as a message.
function context({ post, read }: Environment): ExtensionContext {
  return {
    send: (text) => post({ type: 'extension.send', text }),
    insert: (text) => post({ type: 'extension.insert', text }),
    notice: (text) => post({ type: 'chat.notice', value: text }),
    show: (title, lines) => post({ type: 'extension.show', title, lines }),
    get agent() {
      const { agent } = read()
      return agent ? { id: agent.id, name: agent.name, model: agent.modelName } : null
    },
    get model() {
      return read().agent?.modelName ?? null
    },
    get chatId() {
      return read().chatId
    },
    get cwd() {
      return read().cwd
    }
  }
}

export class Extensions {
  post: Environment['post']
  ctx: ExtensionContext
  problems: string[]
  commands = new Map<string, { extension: string; command: ExtensionCommand }>()
  keys: Binding[] = []
  footers: ExtensionEntry[]
  theme: Partial<Record<keyof typeof palette, string>> = {}

  constructor(
    loaded: LoadedExtensions = { extensions: [], problems: [] },
    {
      builtins,
      reserved,
      post,
      read
    }: Environment & { builtins: Set<string>; reserved: Set<string> }
  ) {
    this.post = post
    this.ctx = context({ post, read })
    this.problems = [...loaded.problems]
    this.commands = new Map()
    this.keys = []
    this.footers = loaded.extensions.filter(({ extension }) => extension.footer)
    this.theme = {}
    for (const entry of loaded.extensions) {
      this.addCommands(entry, builtins)
      this.addKeys(entry, reserved)
      this.addTheme(entry)
    }
  }

  addCommands({ name, extension }: ExtensionEntry, builtins: Set<string>) {
    for (const command of extension.commands ?? []) {
      const key = command.name.toLowerCase()
      if (builtins.has(key) || this.commands.has(key)) {
        this.problems.push(`Extension ${name}: /${key} is already taken`)
      } else {
        this.commands.set(key, { extension: name, command })
      }
    }
  }

  addKeys({ name, extension }: ExtensionEntry, reserved: Set<string>) {
    for (const chord of Object.keys(extension.keys ?? {})) {
      if (
        reserved.has(chord) ||
        chord.length === 1 ||
        this.keys.some((k: { chord: string }) => k.chord === chord)
      ) {
        this.problems.push(`Extension ${name}: ${chord} is already bound`)
      } else {
        this.keys.push({ chord, extension: name, keys: extension.keys! })
      }
    }
  }

  addTheme({ name, extension }: ExtensionEntry) {
    for (const [token, value] of Object.entries(extension.theme ?? {})) {
      const rgb = toRgb(value)
      if (token in palette && rgb) {
        this.theme[token as keyof typeof palette] = rgb
      } else {
        this.problems.push(`Extension ${name}: theme ${token} ignored`)
      }
    }
  }

  entries() {
    return [...this.commands].map(([name, { extension, command }]) => ({
      name,
      desc: `${command.description || 'Extension command'} · ${extension}`
    }))
  }

  bindings() {
    return this.keys.map(({ chord, extension }) => ({ chord, extension }))
  }

  command(name: string, args: string) {
    const found = this.commands.get(name)
    return found ? this.call(found.extension, () => found.command.run(this.ctx, args)) : null
  }

  key(msg: { is(...keys: string[]): boolean }) {
    const found = this.keys.find((k) => msg.is(k.chord))
    return found ? this.call(found.extension, () => found.keys[found.chord]!(this.ctx)) : null
  }

  call(extension: string, fn: () => unknown | Promise<unknown>) {
    return async () => {
      try {
        return { type: 'extension.result', extension, value: await fn() }
      } catch (error) {
        return { type: 'extension.error', extension, error }
      }
    }
  }

  // A footer that throws is dropped, so one bad extension cannot raise an error every frame.
  footer() {
    return this.footers
      .map((entry) => {
        try {
          return entry.extension.footer?.(this.ctx)
        } catch (error) {
          this.footers = this.footers.filter((f) => f !== entry)
          this.post({ type: 'extension.error', extension: entry.name, error })
          return ''
        }
      })
      .filter(Boolean)
      .join(' · ')
  }
}

function toRgb(value: unknown) {
  if (typeof value !== 'string') return null
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (hex) {
    return hex
      .slice(1)
      .map((h) => parseInt(h, 16))
      .join(';')
  }

  return /^\d{1,3};\d{1,3};\d{1,3}$/.test(value) ? value : null
}
