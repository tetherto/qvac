import type {
  LoadedConfig,
  WorkbenchConfig,
  CoreConfig,
  HarnessConfig,
  PluginSpec,
  PluginEntry,
  FolderGrant
} from '../types.js'
type RawCore = Omit<CoreConfig, 'folders'> & { folders?: Array<string | FolderGrant> }
type RawConfig = Omit<Partial<WorkbenchConfig>, 'core'> & {
  core?: RawCore
  harness?: HarnessConfig
  tui?: WorkbenchConfig['tui']
}
import fs from '#fs'
import path from '#path'
import os from '#os'
import process from '#process'
import { pathToFileURL, fileURLToPath } from '#url'
import { importConfig, resolveFrom } from '#config-import'
import { defaults, resolveModel } from './defaults.js'
import { catalogEntry } from './plugin-catalog.js'
import { inlineEntry, inlinePlugin, mergeConfig } from './config-merge.js'
import { runtimeJson } from './config-json.js'

// src/cli and the tests read these from here; the Bare app imports config-merge directly.
export { applyPluginState, describeConfig, mergeConfig, pluginKey } from './config-merge.js'

const extensions = ['json', 'js', 'mjs', 'ts']

export async function loadConfig({
  cwd = process.cwd(),
  file,
  platform = process.platform,
  totalMemoryBytes = os.totalmem(),
  home = os.homedir()
}: {
  cwd?: string
  file?: string | undefined
  platform?: string
  totalMemoryBytes?: number
  home?: string
} = {}): Promise<LoadedConfig> {
  const selected = file
    ? path.resolve(cwd, file)
    : extensions.map((ext) => path.join(cwd, `qvac.config.${ext}`)).find((p) => fs.existsSync(p))
  const loaded = selected ? await readConfigFile(selected) : {}
  assertSections(loaded)

  const base = selected ? path.dirname(selected) : cwd
  const resolve = (p: string) => path.resolve(base, p.replace(/^~(?=$|\/)/, home))
  const user = loaded.core ? { ...loaded, core: resolveCore({ ...loaded.core }, resolve) } : loaded

  const builtIn = defaults({ cwd, platform, totalMemoryBytes, home, model: loaded.core?.model })
  const { config: merged, sources } = mergeConfig(builtIn, user as Partial<WorkbenchConfig>)
  const config: WorkbenchConfig = {
    ...merged,
    core: { ...merged.core },
    harness: { ...merged.harness },
    tui: { ...merged.tui }
  }
  config.tui = { ...merged.tui }
  if (config.core.model) {
    config.core.model = resolveModel(config.core.model, totalMemoryBytes)
  }

  coverFolders(config, sources)
  const listed = loaded.harness?.plugins || []
  config.harness.plugins = await Promise.all(
    (config.harness.plugins || [])
      .filter((p) => typeof p === 'string' || !('enabled' in p) || p.enabled !== false)
      .map((p) => resolvePlugin(p, { base, resolve, listed }))
  )
  assertDelegation(config.harness.delegation || {})
  // throws here, not later in the worker, on a function outside an inline plugin
  runtimeJson({ config })

  return { config, sources, configPath: selected || null }
}

async function readConfigFile(selected: string) {
  if (!fs.existsSync(selected)) {
    throw new Error(`no config at ${selected}`)
  }

  const config: unknown = selected.endsWith('.json')
    ? JSON.parse(fs.readFileSync(selected, 'utf8'))
    : (await importConfig(pathToFileURL(selected).href)).default
  if (!isObject(config)) {
    throw new Error('qvac.config must export a configuration object')
  }

  // plugins are tools for the agent; what changes the app itself is an extension
  if ((config as RawConfig).tui?.plugins) {
    throw new Error('tui.plugins is now tui.extensions: rename it in ' + selected)
  }

  return config as RawConfig
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

// A default policy names the default folder; folders the user grants must fit inside it too.
function coverFolders(config: WorkbenchConfig, sources: { [x: string]: string }) {
  const files = config.harness.policy?.files ? { ...config.harness.policy.files } : undefined
  if (files) config.harness.policy = { ...config.harness.policy, files }
  const folders = config.core.folders
  if (!files || !folders) {
    return
  }

  const widen = (list: readonly string[], paths: string[]) => [...new Set([...list, ...paths])]
  if (sources['harness.policy.files.read'] === 'default' && Array.isArray(files.read)) {
    files.read = widen(
      files.read,
      folders.map((f) => f.path)
    )
  }

  if (sources['harness.policy.files.write'] === 'default' && files.write) {
    files.write = widen(
      files.write,
      folders.filter((f) => f.write).map((f) => f.path)
    )
  }
}

function assertSections(config: RawConfig) {
  for (const key of ['core', 'harness', 'tui']) {
    if (config[key] !== undefined && !isObject(config[key])) {
      throw new Error(`${key} must be an object`)
    }
  }
}

function resolveCore(core: RawCore, resolve: (path: string) => string): CoreConfig {
  for (const key of ['dataDir', 'modelsDir'] as const) {
    if (core[key]) {
      core[key] = resolve(core[key]!)
    }
  }

  if (core.folders) {
    core.folders = core.folders.map((folder) =>
      typeof folder === 'string'
        ? { path: resolve(folder), write: false }
        : { ...folder, path: resolve(folder.path) }
    )
  }

  return core as CoreConfig
}

async function resolvePlugin(
  entry: PluginSpec,
  {
    base,
    resolve,
    listed
  }: { base: string; resolve: (path: string) => string; listed: PluginSpec[] }
) {
  const p: PluginEntry = typeof entry === 'string' ? { use: entry } : (entry as PluginEntry)
  if (inlinePlugin(p)) {
    return inlineEntry(p, listed) as PluginEntry
  }

  if (!p.use) {
    if (p.id && catalogEntry(p.id)) {
      return p
    }

    throw new Error(
      'harness.plugins entries need use (a package name or module path) or id (a catalog plugin)'
    )
  }

  return { ...p, module: await pluginModule(p.use, { base, resolve }) }
}

async function pluginModule(
  use: string,
  { base, resolve }: { base: string; resolve: (path: string) => string }
) {
  if (use.startsWith('.') || path.isAbsolute(use)) {
    return resolve(use)
  }

  if (use.startsWith('@qvac/harness/')) {
    return fileURLToPath(await resolveFrom(use, import.meta.url))
  }

  return fileURLToPath(
    await resolveFrom(use, pathToFileURL(path.join(base, 'qvac.config.js')).href)
  )
}

function assertDelegation(delegation: NonNullable<HarnessConfig['delegation']>) {
  const names = new Set()
  for (const target of delegation.targets || []) {
    if (
      !target.name ||
      target.name === 'local' ||
      names.has(target.name) ||
      !['claude', 'codex', 'acp'].includes(target.protocol) ||
      !target.command
    ) {
      throw new Error(
        'Each delegation target needs a unique name, protocol (claude/codex/acp), and command'
      )
    }

    if (target.login && !['isolated', 'user'].includes(target.login)) {
      throw new Error(`Invalid login for ${target.name}`)
    }

    names.add(target.name)
  }

  for (const k of ['slots', 'maxExternal'] as const) {
    if (delegation[k] !== undefined && (!Number.isInteger(delegation[k]) || delegation[k]! < 1)) {
      throw new Error(`harness.delegation.${k} must be a positive integer`)
    }
  }
}
