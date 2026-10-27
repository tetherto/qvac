import type { HarnessPlugin } from '@qvac/harness/plugins'
import type { PluginSpec, PluginEntry, WorkbenchConfig } from '../types.js'
// No imports: the Node launcher and the Bare app both layer and describe the config with this.
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

// A JS config may list the plugin itself, or { plugin, read, optional, enabled } around it.
export function inlinePlugin(entry: unknown): HarnessPlugin | undefined {
  if (isObject(entry)) {
    return (typeof entry['name'] === 'string' ? entry : entry['plugin']) as
      HarnessPlugin | undefined
  }
  return undefined
}

// The worker finds an inline plugin again at its index in the config file's own list.
export function inlineEntry(entry: PluginEntry | HarnessPlugin, listed: PluginSpec[]) {
  const plugin = inlinePlugin(entry)
  const inline = listed.findIndex((each) => inlinePlugin(each) === plugin)

  return plugin === entry ? { plugin, inline } : { ...entry, inline }
}

// Spread a descriptor, never the plugin, whose methods live on its prototype.
const descriptor = (entry: PluginEntry | HarnessPlugin): PluginEntry =>
  inlinePlugin(entry) === entry ? { plugin: entry as HarnessPlugin } : (entry as PluginEntry)

export const pluginKey = (entry: PluginSpec): string =>
  typeof entry === 'string'
    ? entry
    : ('id' in entry && entry.id) || ('use' in entry && entry.use) || inlinePlugin(entry)!.name

// Objects merge and the user wins; arrays replace, except plugins, which merge by id, use or name.
export function mergeConfig(base: Partial<WorkbenchConfig>, user: Partial<WorkbenchConfig>) {
  const { defaults: useDefaults, ...own } = user
  const sources = {}
  const config = mergeObject('', { base: useDefaults === false ? {} : base, user: own, sources })

  return { config: config as Partial<WorkbenchConfig>, sources }
}

function mergeObject(
  at: string,
  {
    base,
    user,
    sources
  }: {
    base: Record<string, unknown>
    user: Record<string, unknown>
    sources: Record<string, string>
  }
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(base), ...Object.keys(user)])) {
    const path = at ? `${at}.${key}` : key
    out[key] = mergeValue(path, { base: base[key], user: user[key], sources })
  }

  return out
}

const objectOrAbsent = (value: unknown): value is Record<string, unknown> | undefined =>
  value === undefined || isObject(value)

function mergeValue(
  at: string,
  { base, user, sources }: { base: unknown; user: unknown; sources: Record<string, string> }
): unknown {
  if (at === 'harness.plugins') {
    return mergePlugins((base || []) as PluginSpec[], {
      user: (user || []) as PluginSpec[],
      sources
    })
  }

  if (objectOrAbsent(base) && objectOrAbsent(user)) {
    return mergeObject(at, { base: base || {}, user: user || {}, sources })
  }

  sources[at] = user === undefined ? 'default' : 'config'

  return user === undefined ? base : user
}

function mergePlugins(
  base: PluginSpec[],
  { user, sources }: { user: PluginSpec[]; sources: Record<string, string> }
) {
  const merged = new Map(base.map((entry) => [pluginKey(entry), entry]))
  const from = new Map(base.map((entry) => [pluginKey(entry), 'default']))
  for (const entry of user) {
    const key = pluginKey(entry)
    const prior = merged.get(key)
    merged.set(
      key,
      isObject(prior) && isObject(entry)
        ? mergeEntry(prior as PluginEntry, entry as PluginEntry)
        : entry
    )
    from.set(key, 'config')
  }

  const out = []
  for (const [key, entry] of merged) {
    sources[`harness.plugins.${key}`] = from.get(key)!
    if (typeof entry === 'string' || !('enabled' in entry) || entry.enabled !== false) {
      out.push(entry)
    }
  }

  return out
}

function mergeEntry(prior: PluginEntry, entry: PluginEntry) {
  const [a, b] = [descriptor(prior), descriptor(entry)]
  return { ...a, ...b, options: { ...a.options, ...b.options } }
}

const isCatalogEntry = (entry: PluginSpec): entry is PluginEntry & { id: string } =>
  isObject(entry) && typeof entry['id'] === 'string' && !entry['use'] && !entry['module']

// plugins.json over the merged config: enabled adds a catalog id, disabled removes one.
export function applyPluginState<
  T extends { config: WorkbenchConfig; sources: Record<string, string> }
>({ config, sources, ...rest }: T, state: { enabled?: string[]; disabled?: string[] }) {
  const off = new Set(state.disabled || [])
  const plugins = config.harness?.plugins || []
  const kept = plugins.filter((p) => !(isCatalogEntry(p) && off.has(p.id)))
  const have = new Set(kept.map(pluginKey))
  const added = (state.enabled || []).filter((id) => !have.has(id) && !off.has(id))
  const next = { ...sources }
  for (const id of [...added, ...plugins.filter((p) => !kept.includes(p)).map(pluginKey)]) {
    next[`harness.plugins.${id}`] = 'plugins.json'
  }

  return {
    ...rest,
    config: {
      ...config,
      harness: { ...config.harness, plugins: [...kept, ...added.map((id) => ({ id }))] }
    },
    sources: next
  }
}

const WIDTH = 72

const shown = (value: unknown) => {
  const text = JSON.stringify(value) ?? 'undefined'
  return text.length > WIDTH ? `${text.slice(0, WIDTH - 1)}…` : text
}

// One line per merged value, `key = value · source`, for the /config panel and `qvac config`.
export function describeConfig(config: unknown, sources: Record<string, string> = {}) {
  const lines: string[] = []
  const walk = (at: string, value: unknown) => {
    if (at === 'harness.plugins') {
      lines.push(...pluginLines(value as PluginSpec[], sources))
      return
    }

    if (isObject(value) && Object.keys(value).length) {
      for (const [key, each] of Object.entries(value)) {
        walk(at ? `${at}.${key}` : key, each)
      }

      return
    }

    if (!isObject(value)) {
      lines.push(`${at} = ${shown(value)} · ${sources[at] || 'config'}`)
    }
  }
  walk('', config)

  return lines
}

// A plugin a layer turned off is gone from the list, so its line comes from the sources.
function pluginLines(plugins: PluginSpec[], sources: Record<string, string>) {
  const lines = plugins.map((entry) => {
    const key = `harness.plugins.${pluginKey(entry)}`
    const { module: _module, ...rest } = isObject(entry) ? entry : { use: entry }
    return `${key} = ${inlinePlugin(entry) ? 'inline' : shown(rest)} · ${sources[key] || 'config'}`
  })
  const listed = new Set(plugins.map((entry) => `harness.plugins.${pluginKey(entry)}`))
  for (const [key, from] of Object.entries(sources)) {
    if (key.startsWith('harness.plugins.') && !listed.has(key)) {
      lines.push(`${key} = off · ${from}`)
    }
  }

  return lines
}
