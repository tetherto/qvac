import type { PluginEntry } from '../types.js'
import type { CatalogPlugin } from './plugin-catalog.js'
export interface McpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  url?: string
}
export interface PluginState {
  enabled: string[]
  disabled: string[]
  options: Record<string, Record<string, unknown>>
  mcp: { servers: McpServer[] }
}
export interface PluginStateFS {
  readFileSync(path: string, encoding: 'utf8'): string
  mkdirSync(path: string, options: { recursive: true }): unknown
  writeFileSync(path: string, data: string, options: { mode: number }): unknown
  renameSync(from: string, to: string): unknown
}
import { BUILT_IN_PLUGINS, supports } from './plugin-catalog.js'

// fs is passed in (bare-fs or node:fs) so the same module serves the sidecar, the app and tests.
const FILE = 'plugins.json'

const join = (dir: string, name: string) => `${String(dir).replace(/[\\/]+$/, '')}/${name}`

export const pluginStatePath = (dataDir: string) => join(dataDir, FILE)

export function emptyPluginState(): PluginState {
  return { enabled: [], disabled: [], options: {}, mcp: { servers: [] } }
}

// disabled is newer than enabled, so an older file simply has none
const normal = (state: Partial<PluginState> | null | undefined): PluginState => ({
  enabled: [...new Set(state?.enabled || [])],
  disabled: [...new Set(state?.disabled || [])],
  options: { ...state?.options },
  mcp: { servers: [...(state?.mcp?.servers || [])] }
})

// Missing means nothing turned on; a file that is not JSON throws so the caller can say so.
export function readPluginState(dataDir: string, fs: Pick<PluginStateFS, 'readFileSync'>) {
  let text
  try {
    text = fs.readFileSync(pluginStatePath(dataDir), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyPluginState()
    }

    throw error
  }

  return normal(JSON.parse(text))
}

export function writePluginState(dataDir: string, state: Partial<PluginState>, fs: PluginStateFS) {
  const file = pluginStatePath(dataDir)
  const next = normal(state)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(file + '.tmp', file)
  return next
}

// Turning off remembers the id, so a plugin the config turns on by default stays off.
export function setEnabled(state: Partial<PluginState>, id: string, on: boolean) {
  const next = normal(state)
  const add = (list: string[]) => [...new Set([...list, id])]
  const drop = (list: string[]) => list.filter((x) => x !== id)
  next.enabled = on ? add(next.enabled) : drop(next.enabled)
  next.disabled = on ? drop(next.disabled) : add(next.disabled)
  return next
}

// The config's catalog plugins, then plugins.json on top: enabled adds, disabled removes.
export function withConfigPlugins(state: Partial<PluginState>, entries: PluginEntry[] = []) {
  const next = normal(state)
  const configured = entries.filter(
    (e): e is PluginEntry & { id: string } => !!e.id && !e.use && !e.module
  )
  const off = new Set(next.disabled)
  next.enabled = [...new Set([...configured.map((e) => e.id), ...next.enabled])].filter(
    (id) => !off.has(id)
  )
  for (const entry of configured) {
    if (entry.options) {
      next.options[entry.id] = { ...entry.options, ...next.options[entry.id] }
    }
  }

  return next
}

// A need a built-in plugin serves is already met, so it never pulls in a catalog entry.
export function resolvePlugins(
  state: Partial<PluginState>,
  catalog: CatalogPlugin[],
  platform: string
) {
  const enabled = normal(state).enabled
  const served = new Set(BUILT_IN_PLUGINS.flatMap((p) => p.provides || []))
  const entries: Array<CatalogPlugin & { auto: boolean }> = []
  const skipped: Array<{ id: string; reason: string }> = []
  const done = new Map<string, boolean>()
  const skip = (id: string, reason: string) => {
    skipped.push({ id, reason })
    done.set(id, false)
    return false
  }
  const provider = (need: string) =>
    catalog.find((e) => e.id === need) ||
    catalog.find((e) => (e.provides || []).includes(need) && supports(e, platform)) ||
    catalog.find((e) => (e.provides || []).includes(need))
  const visit = (id: string): boolean => {
    if (done.has(id)) {
      return done.get(id)!
    }

    const entry = catalog.find((e) => e.id === id)
    if (!entry) {
      return skip(id, 'not in the plugin catalog')
    }

    if (!supports(entry, platform)) {
      return skip(id, `not available on ${platform}`)
    }

    done.set(id, true)
    // a wanted service someone turned on starts first, so the plugin sees it at setup
    for (const want of entry.wants || []) {
      const dep = provider(want)
      if (dep && enabled.includes(dep.id)) {
        visit(dep.id)
      }
    }

    for (const need of entry.needs || []) {
      if (served.has(need)) continue
      const dep = provider(need)
      if (!dep) {
        return skip(id, `needs ${need}, which no plugin provides`)
      }

      if (!visit(dep.id)) {
        return skip(id, `needs ${need} (${dep.id} cannot start)`)
      }
    }

    entries.push({ ...entry, auto: !enabled.includes(id) })

    return true
  }
  for (const id of enabled) {
    visit(id)
  }

  return { entries, skipped }
}

export const resolveEnabled = (
  state: Partial<PluginState>,
  catalog: CatalogPlugin[],
  platform: string
) => resolvePlugins(state, catalog, platform).entries
