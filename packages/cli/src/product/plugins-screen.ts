import type { Screen, ScreenContext, ScreenRow } from './screen.js'
import type { HostStatus, PluginStatus } from './app-types.js'
import type { CatalogPlugin } from '../lib/runtime/plugin-catalog.js'
import type { PluginEntry } from '../lib/types.js'
import type { PluginState } from '../lib/runtime/plugin-state.js'
type View = ReturnType<typeof view>
import { BUILT_IN_PLUGINS, PLUGIN_CATALOG, supports } from '../lib/runtime/plugin-catalog.js'
import {
  emptyPluginState,
  resolvePlugins,
  setEnabled,
  withConfigPlugins
} from '../lib/runtime/plugin-state.js'

// Harness plugins: what plugins.json asks for against what Core reported at its last start.
const platformOf = (ctx: ScreenContext) =>
  ctx.options?.platform || globalThis.Bare?.platform || globalThis.process?.platform || 'unknown'

const liveOf = (status: HostStatus | null, id: string) =>
  (status?.plugins || []).find((p) => (p.id || p.name) === id) || null

function readState(ctx: ScreenContext) {
  return ctx.options?.readPluginState ? ctx.options.readPluginState() : emptyPluginState()
}

// The config's catalog plugins (the built-in defaults among them) are on unless plugins.json says off.
const configured = (ctx: ScreenContext) =>
  (ctx.options?.config?.harness?.plugins || []).filter(
    (entry): entry is PluginEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      ('id' in entry || 'use' in entry || 'inline' in entry)
  )

function view(ctx: ScreenContext) {
  const platform = platformOf(ctx)
  const state = readState(ctx)
  const status = ctx.options?.readHostStatus?.() || null
  const wanted = withConfigPlugins(state, configured(ctx))
  const { entries, skipped } = resolvePlugins(wanted, PLUGIN_CATALOG, platform)
  return { platform, state, enabled: wanted.enabled, status, entries, skipped, ctx }
}

function origin(v: View, id: string) {
  if (!configured(v.ctx).some((p) => p.id === id && !p.use && !p.module)) {
    return null
  }

  const from = v.ctx.options?.sources?.[`harness.plugins.${id}`]

  return (
    ({ config: 'qvac.config', default: 'the built-in defaults' } as Record<string, string>)[
      from || ''
    ] || null
  )
}

const shellOff = (v: View) =>
  v.status?.shell?.blocked ? `Runs refused: sandbox unavailable (${v.status.shell.reason})` : null

// The first catalog plugin the person turned on that pulled this one in.
const pulledBy = (v: View, id: string) =>
  v.entries.find(
    (e) =>
      !e.auto &&
      v.entries.some((d) => d.id === id && d.auto) &&
      (e.needs || []).some(
        (n: string) => n === id || PLUGIN_CATALOG.find((c) => c.id === id)?.provides?.includes(n)
      )
  )

function badgeOf(v: View, entry: CatalogPlugin): ScreenRow['badge'] | null {
  if (!supports(entry, v.platform)) {
    return { text: `not on ${v.platform}`, color: 'muted' }
  }

  const desired = v.entries.some((e) => e.id === entry.id)
  const live = liveOf(v.status, entry.id)
  const running = live?.state === 'ready'
  if (desired && live?.state === 'failed') {
    return { text: 'failed', color: 'red' }
  }

  if (desired && live?.state === 'skipped') {
    return { text: 'skipped', color: 'red' }
  }

  if (v.enabled.includes(entry.id) && !desired) {
    return { text: 'cannot start', color: 'red' }
  }

  if (desired !== running) {
    return { text: 'restart to apply', color: 'teal' }
  }

  if (running) {
    return { text: 'ready', color: 'green' }
  }

  return null
}

const pending = (v: View) =>
  PLUGIN_CATALOG.some((entry) => badgeOf(v, entry)?.text === 'restart to apply')

function catalogDetail(v: View, entry: CatalogPlugin) {
  const auto = v.entries.find((e) => e.id === entry.id && e.auto)
  const by = auto && pulledBy(v, entry.id)
  if (by) {
    return `on with ${by.name}`
  }

  if (entry.setup && v.enabled.includes(entry.id) && !v.state.options[entry.id]) {
    return `needs ${entry.setup}`
  }

  return entry.description
}

function catalogRow(v: View, entry: CatalogPlugin) {
  return {
    id: entry.id,
    label: entry.name,
    detail: catalogDetail(v, entry),
    state: v.enabled.includes(entry.id) ? 'on' : 'off',
    badge: badgeOf(v, entry) ?? undefined
  }
}

// Plugins qvac.config lists by use or inline: the catalog does not know them, the status does.
const ownPlugins = (v: View) =>
  (v.status?.plugins || []).filter(
    (p) => p.source === 'config' && !PLUGIN_CATALOG.some((e) => e.id === p.id)
  )

const STATE_COLOR: Record<string, NonNullable<ScreenRow['badge']>['color']> = {
  ready: 'green',
  failed: 'red'
}

function ownRow(live: PluginStatus) {
  return {
    id: `config:${live.id}`,
    label: live.name || live.id,
    detail: live.tools?.length ? live.tools.join(', ') : 'from qvac.config',
    badge: { text: live.state, color: STATE_COLOR[live.state] || 'muted' }
  }
}

function builtInRow(v: View, entry: (typeof BUILT_IN_PLUGINS)[number]): ScreenRow {
  const live = (v.status?.builtIn || []).find((p) => p.id === entry.id)
  return {
    id: `builtin:${entry.id}`,
    label: entry.name,
    detail: live?.tools?.length ? live.tools.join(', ') : entry.description,
    badge: { text: 'built in', color: 'muted' }
  }
}

function needLine(v: View, need: string) {
  const dep = v.entries.find((e) => e.id === need || (e.provides || []).includes(need))
  if (dep && dep.id !== need) {
    return `${need} (${dep.name})`
  }

  const builtIn = BUILT_IN_PLUGINS.find((p) => (p.provides || []).includes(need))

  return builtIn ? `${need} (built-in ${builtIn.name})` : need
}

function statusLines(v: View, entry: CatalogPlugin) {
  const live = liveOf(v.status, entry.id)
  const lines = []
  const badge = badgeOf(v, entry)
  lines.push(
    `Status: ${live ? live.state : 'not loaded'}${badge && badge.text !== live?.state ? ` · ${badge.text}` : ''}`
  )
  if (live?.error) {
    lines.push(`Error: ${live.error}`)
  }

  const reason = v.skipped.find((s) => s.id === entry.id)?.reason
  if (reason && reason !== live?.error) {
    lines.push(`Cannot start: ${reason}`)
  }

  const tools = live?.tools?.length ? live.tools : entry.tools
  if (tools?.length) {
    lines.push(`Tools${live?.tools?.length ? '' : ' (when on)'}: ${tools.join(', ')}`)
  }

  return lines
}

function originLines(v: View, entry: CatalogPlugin) {
  const lines: string[] = liveOf(v.status, entry.id)?.shellBlocked
    ? [shellOff(v) || 'Shell unavailable']
    : []
  const from = origin(v, entry.id)
  if (from) {
    lines.push(
      v.state.disabled.includes(entry.id)
        ? `On in ${from}; turned off here`
        : `On in ${from}; space turns it off`
    )
  }

  return lines
}

function details(v: View, entry: CatalogPlugin) {
  const lines = [entry.description, '', ...statusLines(v, entry), ...originLines(v, entry)]
  if (entry.needs?.length) {
    lines.push(`Needs: ${entry.needs.map((n) => needLine(v, n)).join(', ')}`)
  }

  if (entry.provides?.length) {
    lines.push(`Provides: ${entry.provides.join(', ')}`)
  }

  if (entry.wants?.length) {
    lines.push(`Uses when present: ${entry.wants.join(', ')}`)
  }

  if (entry.platforms) {
    lines.push(`Platforms: ${entry.platforms.join(', ')}`)
  }

  const by = pulledBy(v, entry.id)
  if (by) {
    lines.push(`Turned on with: ${by.name}`)
  }

  if (entry.setup) {
    lines.push('', `Setup: ${entry.setup} (plugins.json options.${entry.id})`)
  }

  const options = v.state.options[entry.id]
  if (options) {
    lines.push('', `Options: ${JSON.stringify(options)}`)
  }

  return lines
}

function mcpBadge(live: PluginStatus | null, count: number): ScreenRow['badge'] | null {
  const running = live?.state === 'ready'
  if (live?.state === 'failed') {
    return { text: 'failed', color: 'red' }
  }

  if (count > 0 !== running) {
    return { text: 'restart to apply', color: 'teal' }
  }

  return running ? { text: 'ready', color: 'green' } : null
}

function mcpRow(v: View) {
  const live = liveOf(v.status, 'mcp-servers')
  const count = v.state.mcp.servers.length
  return {
    id: 'mcp-servers',
    label: 'MCP servers',
    detail: count
      ? v.state.mcp.servers.map((s) => s.name).join(', ')
      : 'none · m adds one (Streamable HTTP, public hosts only)',
    badge: mcpBadge(live, count) ?? undefined
  }
}

function mcpDetails(v: View) {
  const live = liveOf(v.status, 'mcp-servers')
  return [
    "Remote MCP servers over Streamable HTTP. Each server's tools become <server>__<tool> tools.",
    'There is no stdio transport, and localhost or private-network hosts are refused.',
    '',
    ...(v.state.mcp.servers.length
      ? v.state.mcp.servers.map((s) => `${s.name}  ${s.url}`)
      : ['No servers yet: press m to add one.']),
    ...(live
      ? [
          '',
          `Status: ${live.state}`,
          ...(live.error ? [`Error: ${live.error}`] : []),
          ...(live.tools?.length ? [`Tools: ${live.tools.join(', ')}`] : [])
        ]
      : [])
  ]
}

function save(ctx: ScreenContext, state: PluginState) {
  if (!ctx.options?.writePluginState) {
    throw new Error('This build cannot save plugin changes')
  }

  return ctx.options.writePluginState(state)
}

export const pluginsScreen: Screen = {
  title: 'Plugins',
  hint: 'space toggle  enter details  r restart Core to apply  m add MCP server',
  load(ctx) {
    const v = view(ctx)
    const note = []
    if (!ctx.options?.readPluginState) {
      note.push('Plugin settings are not available in this build.')
    }

    if (!v.status) {
      note.push('Core has not reported plugin status yet.')
    }

    if (shellOff(v)) {
      note.push(shellOff(v)!)
    }

    if (
      pending(v) ||
      v.state.mcp.servers.length > 0 !== (liveOf(v.status, 'mcp-servers')?.state === 'ready')
    ) {
      note.push(
        ctx.options?.restartCore
          ? 'Changes apply when Core restarts: press r.'
          : 'Changes apply the next time QVAC starts.'
      )
    }

    return {
      rows: [
        ...PLUGIN_CATALOG.map((e) => catalogRow(v, e)),
        ...ownPlugins(v).map(ownRow),
        mcpRow(v),
        ...BUILT_IN_PLUGINS.map((e) => builtInRow(v, e))
      ],
      note
    }
  },
  async toggle(ctx, row) {
    if (row.id.startsWith('config:')) {
      throw new Error('This plugin is listed in qvac.config: change it there, then press r')
    }

    const entry = PLUGIN_CATALOG.find((e) => e.id === row.id)
    const on = row.state !== 'on'
    if (!entry) throw new Error('This plugin cannot be toggled')
    if (on && !supports(entry, platformOf(ctx))) {
      throw new Error(`${entry.name} is not available on ${platformOf(ctx)}`)
    }

    await save(ctx, setEnabled(readState(ctx), row.id, on))
  },
  open(ctx, row: { id: string }) {
    const v = view(ctx)
    if (row.id === 'mcp-servers') {
      return { title: 'MCP servers', lines: mcpDetails(v) }
    }

    const own = ownPlugins(v).find((p) => `config:${p.id}` === row.id)
    if (own) {
      return {
        title: own.name || own.id,
        lines: [
          'From qvac.config. Edit it there, then press r to restart Core.',
          ...(own.tools?.length ? [`Tools: ${own.tools.join(', ')}`] : []),
          ...(own.error ? ['', own.error] : [])
        ]
      }
    }

    const builtIn = BUILT_IN_PLUGINS.find((e) => `builtin:${e.id}` === row.id)
    if (builtIn) {
      const live = (v.status?.builtIn || []).find((p: { id: string }) => p.id === builtIn.id)
      return {
        title: builtIn.name,
        lines: [
          builtIn.description,
          '',
          'Built in: Core always loads it.',
          ...(live?.tools?.length ? [`Tools: ${live.tools.join(', ')}`] : [])
        ]
      }
    }

    const entry = PLUGIN_CATALOG.find((e) => e.id === row.id)

    if (!entry) throw new Error('Plugin no longer exists')
    return { title: entry.name, lines: details(v, entry) }
  },
  actions: [
    {
      key: 'r',
      label: 'restart Core',
      async run(ctx) {
        if (!ctx.options?.restartCore) {
          throw new Error('Restart QVAC to apply plugin changes')
        }

        await ctx.options.restartCore()
      }
    },
    {
      key: 'm',
      label: 'add MCP server',
      run(ctx) {
        return {
          prompt: {
            label: 'MCP server (name https://url)',
            async submit(value: string) {
              const [name, url] = value.trim().split(/\s+/)
              if (!/^[a-z0-9_-]+$/.test(name || '') || !name || name.includes('__')) {
                throw new Error('Name: lowercase letters, digits, _ and -, without __')
              }

              if (!url || !/^https?:\/\//.test(url)) {
                throw new Error('Give an http or https URL after the name')
              }

              const state = readState(ctx)
              state.mcp.servers = [
                ...state.mcp.servers.filter((s) => s.name !== name),
                { name, url }
              ]
              await save(ctx, state)
            }
          }
        }
      }
    }
  ]
}
