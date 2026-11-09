// Runs in the execution worker, before addons are sealed and RPC starts serving.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
import { pathToFileURL } from 'bare-url'
import { Agent } from '@qvac/harness/agent'
import { ExternalAgents } from '@qvac/harness/plugins/external-agents'
import { sharedImports } from '@qvac/harness/user-plugins'
import { BUILT_IN_PLUGINS, PLUGIN_CATALOG } from './plugin-catalog.js'
import { inlinePlugin } from './config-merge.js'
import { hostShell } from './host-shell.js'
import {
  emptyPluginState,
  readPluginState,
  resolvePlugins,
  withConfigPlugins
} from './plugin-state.js'
import type { Harness, HarnessPlugin, CompletionContext, CompletionEvent } from '@qvac/harness'
import type Module from 'bare-module'
import type { HarnessConfig, PluginEntry, WorkbenchConfig, LoadedConfig } from '../types.js'
import type { CatalogPlugin } from './plugin-catalog.js'
import type { PluginState, McpServer } from './plugin-state.js'
type Log = { info(area: string, message: string): void; error(area: string, message: string): void }
type Built = Map<string, HarnessPlugin>
type Constructor = new (options: unknown, extra?: unknown) => HarnessPlugin
interface PluginReport {
  id: string
  name: string
  state: string
  tools: string[]
  source?: string | undefined
  error?: string
  shellBlocked?: boolean
  shellReason?: string
}
interface HostStatus {
  plugins: PluginReport[]
  builtIn: Array<{ id: string; name: string; tools: string[] }>
  delegation: string[]
  shell: { blocked: boolean; unsandboxed?: boolean; reason: string } | null
  tools: Array<{ name: string; toolset?: string | null | undefined }>
  writtenAt: string | null
}
type Adder = ReturnType<typeof pluginAdder>
type Run = Parameters<Harness['completion']>[0]

// Literal imports, so a bundle sees each one and none loads until it is turned on.
const LOADERS = {
  coding: () => import('@qvac/harness/plugins/coding'),
  'sandbox-macos': () => import('@qvac/harness/plugins/sandbox-macos'),
  'sandbox-linux': () => import('@qvac/harness/plugins/sandbox-linux'),
  'sandbox-windows': () => import('@qvac/harness/plugins/sandbox-windows'),
  'sandbox-vm': () => import('@qvac/harness/plugins/sandbox-vm'),
  'egress-proxy': () => import('@qvac/harness/plugins/egress-proxy'),
  lsp: () => import('@qvac/harness/plugins/lsp'),
  quickjs: () => import('@qvac/harness/plugins/quickjs'),
  'code-mode': () => import('@qvac/harness/plugins/code-mode'),
  'command-hooks': () => import('@qvac/harness/plugins/command-hooks'),
  'language-hint': () => import('@qvac/harness/plugins/language-hint'),
  'walkie-talkie': () => import('@qvac/harness/plugins/walkie-talkie')
}

const LSP_SERVERS = [
  {
    language: 'typescript',
    bin: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
  },
  { language: 'python', bin: 'pyright-langserver', args: ['--stdio'], extensions: ['.py'] },
  { language: 'go', bin: 'gopls', args: [], extensions: ['.go'] },
  { language: 'rust', bin: 'rust-analyzer', args: [], extensions: ['.rs'] },
  { language: 'cpp', bin: 'clangd', args: [], extensions: ['.c', '.h', '.cc', '.cpp', '.hpp'] }
]

const home = (p: string) => p.replace(/^~(?=$|[\\/])/, os.homedir())

// A GUI launch has a short PATH, so only what it can see is found; options.servers is the sure way.
function lspServers() {
  const dirs = (process.env['PATH'] || '').split(path.delimiter).filter(Boolean)
  return LSP_SERVERS.flatMap(({ bin, ...server }) => {
    const command = dirs.map((dir) => path.join(dir, bin)).find((file) => fs.existsSync(file))
    return command ? [{ ...server, command }] : []
  })
}

const BUILDS: Record<
  string,
  (Plugin: Constructor, options: Record<string, unknown>) => HarnessPlugin
> = {
  lsp: (Plugin, { servers, ...options }) => {
    const found = (servers as unknown[] | undefined) || lspServers()
    if (!found.length) {
      throw new Error(
        `no language server found on PATH (${LSP_SERVERS.map((s) => s.bin).join(', ')}); list them in options.servers`
      )
    }

    return new Plugin({ ...options, servers: found })
  },
  'command-hooks': (Plugin, { hooks, settings, cwd }) =>
    new Plugin(
      hooks ?? JSON.parse(fs.readFileSync(home(settings as string), 'utf8')).hooks,
      cwd ? { cwd } : {}
    )
}

async function catalogPlugin(
  entry: CatalogPlugin,
  overrides: Record<string, unknown> | undefined,
  built: Built
) {
  const exports = await LOADERS[entry.id as keyof typeof LOADERS]()
  const Plugin = (exports as unknown as Record<string, Constructor>)[entry.export]!
  const options: Record<string, unknown> = { ...entry.options, ...overrides }
  for (const [key, id] of Object.entries(entry.inject || {})) {
    if (!built.has(id)) throw new Error(`needs ${id}, which did not start`)
    options[key] = built.get(id)
  }

  const read = (options['read'] as string[] | undefined) || entry.read
  const plugin = entry.build
    ? BUILDS[entry.build]!(Plugin, options)
    : new Plugin({ ...options, read })
  if (read) {
    plugin.read = read
  }

  return plugin
}

async function configPlugin(entry: PluginEntry, self: Module, imports: Record<string, string>) {
  const exports = (
    await (self.constructor as typeof import('bare-module')).load(pathToFileURL(entry.module!), {
      referrer: self,
      imports
    })
  ).exports
  const plugin = await instantiate(exports, entry)
  if (!plugin?.setup) {
    throw new Error('Module must export a plugin factory or name a plugin class with export')
  }

  plugin.read = entry.read || []

  return plugin
}

async function inlineConfigPlugin(entry: PluginEntry, file: () => Promise<WorkbenchConfig>) {
  const plugin = inlinePlugin((await file()).harness.plugins![entry.inline!])!
  plugin.read = entry.read || []

  return plugin
}

// Loaded once per boot, through the same loader as module plugins, so its imports are shared.
function configFile(configPath: string | null, self: Module, imports: Record<string, string>) {
  let loading: Promise<WorkbenchConfig> | null = null
  return () => {
    loading ??= (self.constructor as typeof import('bare-module'))
      .load(pathToFileURL(configPath!), { referrer: self, imports })
      .then(
        ({ exports }) =>
          ((exports as { default?: WorkbenchConfig }).default ?? exports) as WorkbenchConfig
      )
      .catch((error) => {
        throw new Error(
          `qvac.config did not load under Bare: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    return loading
  }
}

async function instantiate(exports: unknown, entry: PluginEntry): Promise<HarnessPlugin> {
  const module = exports as {
    default?:
      | HarnessPlugin
      | ((options: { options: Record<string, unknown> }) => HarnessPlugin | Promise<HarnessPlugin>)
    [key: string]: unknown
  }
  if (entry.export) {
    return new (module[entry.export] as Constructor)({ ...entry.options, read: entry.read || [] })
  }

  if (typeof module.default === 'function') {
    return await module.default({ options: entry.options || {} })
  }

  return module.default as HarnessPlugin
}

// The sidecar's argv[3] is its SDK storage, whose home is <dataDir>/sdk-home.
function sidecarDataDir() {
  const storage = globalThis.Bare?.argv?.[3]
  const sdkHome = storage && JSON.parse(storage).home
  return sdkHome ? path.dirname(sdkHome) : null
}

function readConfig(): Partial<LoadedConfig> {
  const file = process.env['QVAC_CLI_CONFIG']
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
}

export async function configureHarness(
  harness: Harness,
  log: Log,
  { platform = process.platform } = {}
) {
  const { config = null, sources = {}, configPath = null } = readConfig()
  const options = config?.harness || {}
  const dataDir = config?.core?.dataDir || process.env['QVAC_CLI_DATA_DIR'] || sidecarDataDir()
  if (!dataDir) {
    return
  }

  const built: Built = new Map()
  const status = initialStatus(harness, options)
  const add = pluginAdder(harness, { built, status, log })
  const plugins = (options.plugins || []) as PluginEntry[]
  const own = plugins.filter((p) => p.module || p.inline !== undefined)
  const claimed = own.length
    ? await addConfigPlugins(own, { add, configPath })
    : new Set<string | null>()

  const state = readStateOrReport(dataDir, status)
  const catalog = plugins.filter((p) => !own.includes(p))
  const wanted = withConfigPlugins(state || emptyPluginState(), catalog)
  const from = (id: string) =>
    catalog.some((p) => p.id === id) ? sources[`harness.plugins.${id}`] : 'plugins.json'
  await addCatalogPlugins(wanted, {
    add,
    claimed,
    built,
    status,
    platform,
    from,
    plugins,
    unsandboxed: options.allowUnsandboxedShell === true
  })
  if (state?.mcp.servers.length) {
    await addMcpServers(harness, { servers: state.mcp.servers, add })
  }

  const blocked = shellBlock(status, options)
  if (config) {
    wrapCompletion(harness, { options, config, blocked, log })
  }

  status.tools = (await harness.tools()).map((t) => ({ name: t.name, toolset: t.toolset }))
  status.writtenAt = new Date().toISOString()
  fs.writeFileSync(path.join(dataDir, 'cli-host-status.json'), JSON.stringify(status))
}

function initialStatus(harness: Pick<Harness, 'toolNames'>, options: HarnessConfig): HostStatus {
  const base = new Set(harness.toolNames)
  return {
    plugins: [],
    builtIn: BUILT_IN_PLUGINS.map((p) => ({
      id: p.id,
      name: p.name,
      tools: p.tools.filter((t) => base.has(t))
    })),
    delegation: (options.delegation?.targets || []).map((t) => t.name),
    shell: null,
    tools: [],
    writtenAt: null
  }
}

function pluginAdder(
  harness: Harness,
  { built, status, log }: { built: Built; status: HostStatus; log: Log }
) {
  return async (
    {
      id,
      name,
      source,
      optional = false
    }: { id: string; name: string; source?: string | undefined; optional?: boolean | undefined },
    make: () => Promise<HarnessPlugin> | HarnessPlugin
  ) => {
    try {
      const before = new Set(harness.toolNames)
      const plugin = await make()
      await harness.addPlugin(plugin)
      built.set(plugin.name, plugin)
      status.plugins.push({
        id,
        name,
        state: 'ready',
        tools: harness.toolNames.filter((t) => !before.has(t)),
        source
      })
      log.info('cli', `Plugin ready: ${plugin.name}`)

      return plugin.name
    } catch (error) {
      // an optional plugin that cannot start, such as lsp with no server installed, was never on
      const state = optional ? 'skipped' : 'failed'
      status.plugins.push({
        id,
        name,
        state,
        error: error instanceof Error ? error.message : String(error),
        tools: [],
        source
      })
      log[optional ? 'info' : 'error'](
        'cli',
        `Plugin ${id} ${state}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }
}

async function addConfigPlugins(
  plugins: PluginEntry[],
  { add, configPath }: { add: Adder; configPath: string | null }
) {
  const claimed = new Set<string | null>()
  const self = import.meta.cache[import.meta.url]!
  const imports = await sharedImports()
  const file = configFile(configPath, self, imports)
  for (const entry of plugins) {
    const known = entry.id || PLUGIN_CATALOG.find((c) => c.use === entry.use)?.id
    const label = known || entry.use || entry.name || 'inline'
    const loaded = await add(
      { id: label, name: label, source: 'config', optional: entry.optional },
      () => (entry.module ? configPlugin(entry, self, imports) : inlineConfigPlugin(entry, file))
    )
    claimed.add(known || loaded)
    if (loaded) {
      claimed.add(loaded)
    }
  }

  return claimed
}

function readStateOrReport(dataDir: string, status: HostStatus) {
  try {
    return readPluginState(dataDir, fs)
  } catch (error) {
    status.plugins.push({
      id: 'plugins.json',
      name: 'plugins.json',
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
      tools: [],
      source: 'plugins.json'
    })
    return null
  }
}

async function addCatalogPlugins(
  state: PluginState,
  {
    add,
    claimed,
    built,
    status,
    platform,
    from,
    plugins,
    unsandboxed
  }: {
    add: Adder
    claimed: Set<string | null>
    built: Built
    status: HostStatus
    platform: string
    from(id: string): string | undefined
    plugins: PluginEntry[]
    unsandboxed: boolean
  }
) {
  const { entries, skipped } = resolvePlugins(state, PLUGIN_CATALOG, platform)
  for (const { id, reason } of skipped) {
    status.plugins.push({
      id,
      name: PLUGIN_CATALOG.find((c) => c.id === id)?.name || id,
      state: 'skipped',
      error: reason,
      tools: [],
      source: from(id)
    })
  }

  const sandboxed = () => [...built.values()].some((p) => p.provides?.includes('sandbox'))
  for (const entry of entries) {
    // allowUnsandboxedShell: the coding shell runs unconfined when no sandbox started or none is on
    if (unsandboxed && entry.needs?.includes('sandbox') && !sandboxed()) {
      await add({ id: 'host-shell', name: 'Unconfined shell', source: 'config' }, hostShell)
    }

    if (!claimed.has(entry.id)) {
      const optional = plugins.some((p) => p.id === entry.id && p.optional)
      await add({ id: entry.id, name: entry.name, source: from(entry.id), optional }, () =>
        catalogPlugin(entry, state.options[entry.id], built)
      )
    }
  }
}

// A host list holds only through the egress proxy, so under one the proxy is part of the sandbox.
export function shellBlock(status: HostStatus, options: HarnessConfig) {
  const hosts = options.policy?.network?.mode === 'hosts'
  const down = status.plugins.filter(
    (p) =>
      (p.id.startsWith('sandbox-') || (hosts && p.id === 'egress-proxy')) && p.state !== 'ready'
  )
  const unconfined = status.plugins.some((p) => p.id === 'host-shell' && p.state === 'ready')
  if (!down.length) {
    if (unconfined) {
      status.shell = { blocked: false, unsandboxed: true, reason: 'no sandbox plugin is on' }
    }

    return null
  }

  const reason = down.map((p) => `${p.id}: ${p.error || p.state}`).join('; ')
  if (options.allowUnsandboxedShell === true) {
    status.shell = { blocked: false, unsandboxed: true, reason }
    return null
  }

  for (const p of down) {
    p.shellBlocked = true
    p.shellReason = reason
  }

  status.shell = { blocked: true, reason }

  return reason
}

// Without its sandbox nothing runs: qvac.config can drop the sandbox or set allowUnsandboxedShell.
async function* refused(reason: string): AsyncGenerator<CompletionEvent> {
  yield {
    type: 'error',
    message: `The sandbox did not start (${reason}). Fix it, or turn it off in qvac.config.`
  }
}

// A delegated child copies its parent's rounds, so it inherits them.
export function shapeRun(context: Run, { options }: { options: HarnessConfig }): Run {
  const run: Run = {
    ...context,
    ...(context.policy || options.policy ? { policy: context.policy || options.policy! } : {}),
    ...((context.planMode ?? options.planMode) !== undefined
      ? { planMode: context.planMode ?? options.planMode! }
      : {}),
    // the model-facing text qvac.config words for every run; a run's own wording wins key by key
    ...(options.wording || context.wording
      ? { wording: { ...options.wording, ...context.wording } as NonNullable<Run['wording']> }
      : {})
  }
  if (!context.parentRunId && !context.resume) {
    const rounds = context.maxToolRounds ?? options.maxToolRounds
    if (rounds !== undefined) run.maxToolRounds = rounds
  }

  // how much each round thinks; a resumed run keeps what it started with
  if (!context.resume) {
    const params = thinking(context.generationParams, options)
    if (params !== undefined) run.generationParams = params
  }

  return run
}

// reasoningBudget caps each round; thinking 'plan' thinks only after the user or a failed round
function thinking(
  params: CompletionContext['generationParams'],
  { reasoningBudget, thinking: rounds }: HarnessConfig
) {
  const shaped = { ...params }
  if (Number.isInteger(reasoningBudget)) {
    shaped.reasoning_budget = reasoningBudget!
  }

  if (rounds === 'plan') {
    shaped.reasoning_rounds = 'plan'
  }

  return Object.keys(shaped).length ? shaped : params
}

// A second McpPlugin, renamed: the built-in 'mcp' keeps the skill catalog only the sidecar holds.
function addMcpServers(harness: Harness, { servers, add }: { servers: McpServer[]; add: Adder }) {
  return add({ id: 'mcp-servers', name: 'MCP servers', source: 'mcp' }, async () => {
    const { McpPlugin } = await import('@qvac/harness/plugins/mcp')
    const plugin = new McpPlugin({
      servers: servers as import('@qvac/harness/plugins/mcp').McpServerConfig[],
      credentialStore: (key, ctx) => harness.resolveCredential(key, ctx) ?? null
    })
    Object.defineProperty(plugin, 'name', { value: 'mcp-servers' })

    return plugin as HarnessPlugin
  })
}

function wrapCompletion(
  harness: Harness,
  {
    options,
    config,
    blocked,
    log
  }: { options: HarnessConfig; config: WorkbenchConfig; blocked: string | null; log: Log }
) {
  const delegation = options.delegation || {}
  const targets = ExternalAgents.targets({
    dir: path.join(config.core.dataDir!, 'external-agents'),
    targets: delegation.targets || []
  })
  const original = harness.completion.bind(harness)
  // Children call this original port; the host must never put delegate back on a child.
  const childHost = { completion: original }
  harness.completion = function (context) {
    if (blocked) {
      return refused(blocked)
    }

    const run = shapeRun(context, { options })
    if (!context.parentRunId && delegation.enabled !== false) {
      run.tools = [
        ...(context.tools || []),
        Agent.delegateTool(childHost, run, {
          slots: delegation.slots || 1,
          maxExternal: delegation.maxExternal || 2,
          targets,
          read: delegation.read || []
        })
      ]
    }

    return original(run)
  }
  if (blocked) {
    log.error('cli', `Runs refused: sandbox unavailable (${blocked})`)
  }

  log.info('cli', `Delegation ready: local${targets.map((t) => `, ${t.name}`).join('')}`)
}
