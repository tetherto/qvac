import {
  pluginDefinitionRuntimeSchema,
  type QvacPlugin,
  type PluginHandlerDefinition
} from '@/schemas/plugin'
import { isModelTypeAlias } from '@/schemas/index'
import {
  PluginAlreadyRegisteredError,
  PluginDefinitionInvalidError,
  PluginLoggingInvalidError,
  PluginModelTypeReservedError
} from '@/errors/index'
import { createAddonLoggerCallback } from '@/logging/addon'
import { getEngineLogger } from '@/logging'
import { formatZodError } from '@/utils/zod-error'

const plugins = new Map<string, QvacPlugin>()

interface PluginLoggingModule {
  setLogger: (callback: (priority: number, message: string) => void) => void
  releaseLogger?: () => void
}

/**
 * A plugin may hand over its addon's logging module directly, or a resolver
 * that produces it. A resolver defers loading the addon: `import()`ing an
 * addon's `addonLogging` entry point pulls in its native binding, and since
 * the per-platform prebuild split that binding is absent on any host whose
 * platform package was not installed. Registering a plugin must not depend on
 * that — every addon is an optional peer dependency — so a resolver is called
 * when a model of that type is first loaded, not when the plugin registers.
 */
type PluginLoggingResolver = () => unknown

/** Addon logging modules wired through a resolver, keyed by namespace. */
const lazyAddonLoggers = new Map<string, PluginLoggingModule>()
/** In-flight resolutions, so concurrent loads wire a namespace exactly once. */
const pendingAddonLoggers = new Map<string, Promise<void>>()

function getLoggingResolver(plugin: QvacPlugin): PluginLoggingResolver | undefined {
  const declared = plugin.logging?.module
  return typeof declared === 'function' ? (declared as PluginLoggingResolver) : undefined
}

/**
 * The module a plugin supplied directly, or `undefined` when it supplied a
 * resolver. Resolver-based plugins are therefore invisible to
 * registration-time shape validation, to the shared-module dedupe, and to the
 * eager release sweeps; `ensureAddonLoggerReady` and `lazyAddonLoggers` cover
 * them instead, keyed by namespace rather than held on the plugin.
 */
function getLoggingModule(plugin: QvacPlugin) {
  if (getLoggingResolver(plugin)) return undefined
  return plugin.logging?.module as PluginLoggingModule | undefined
}

/** CommonJS addons resolve through `import()` as a namespace with `default`. */
function unwrapLoggingModule(resolved: unknown): unknown {
  if (resolved && typeof resolved === 'object' && 'default' in resolved) {
    const inner = (resolved as { default: unknown }).default
    if (inner && typeof (inner as PluginLoggingModule).setLogger === 'function') return inner
  }
  return resolved
}

function assertLoggingModuleShape(modelType: string, candidate: unknown): PluginLoggingModule {
  if (!candidate || typeof (candidate as Record<string, unknown>)['setLogger'] !== 'function') {
    throw new PluginLoggingInvalidError(
      modelType,
      'logging.module must have a setLogger(callback) function'
    )
  }
  return candidate as PluginLoggingModule
}

function findPluginUsingLoggingModule(loggingModule: PluginLoggingModule) {
  return Array.from(plugins.values()).find((plugin) => plugin.logging?.module === loggingModule)
}

function findPluginProvidingTurboVecIndex() {
  return Array.from(plugins.values()).find((plugin) => plugin.capabilities?.turbovecIndexProvider)
}

function getModelTypeForError(plugin: unknown) {
  if (!plugin || typeof plugin !== 'object') return '(unknown)'
  if (!('modelType' in plugin)) return '(unknown)'
  const modelType = (plugin as { modelType?: unknown }).modelType
  return typeof modelType === 'string' && modelType.length > 0 ? modelType : '(unknown)'
}

function validatePluginDefinition(plugin: QvacPlugin): void {
  const result = pluginDefinitionRuntimeSchema.safeParse(plugin)
  if (result.success) return

  throw new PluginDefinitionInvalidError(getModelTypeForError(plugin), formatZodError(result.error))
}

export function registerPlugin(plugin: QvacPlugin): void {
  validatePluginDefinition(plugin)

  if (isModelTypeAlias(plugin.modelType)) {
    throw new PluginModelTypeReservedError(plugin.modelType)
  }

  if (plugins.has(plugin.modelType)) {
    throw new PluginAlreadyRegisteredError(plugin.modelType)
  }

  const pluginProvidingTurboVecIndex = plugin.capabilities?.turbovecIndexProvider
    ? findPluginProvidingTurboVecIndex()
    : undefined
  if (pluginProvidingTurboVecIndex) {
    throw new PluginDefinitionInvalidError(
      plugin.modelType,
      `plugin "${plugin.modelType}" cannot provide turbovecIndexProvider because plugin "${pluginProvidingTurboVecIndex.modelType}" already provides it`
    )
  }

  // Validate logging module shape if provided. A resolver is checked when it
  // runs instead: calling it here to inspect its result would load the addon,
  // which is the whole thing registration is meant to avoid.
  if (plugin.logging?.module && !getLoggingResolver(plugin)) {
    assertLoggingModuleShape(plugin.modelType, plugin.logging.module)
  }

  const loggingModule = getLoggingModule(plugin)
  const pluginUsingLoggingModule = loggingModule
    ? findPluginUsingLoggingModule(loggingModule)
    : undefined
  if (
    pluginUsingLoggingModule &&
    pluginUsingLoggingModule.logging?.namespace !== plugin.logging?.namespace
  ) {
    throw new PluginLoggingInvalidError(
      plugin.modelType,
      'plugins sharing logging.module must use the same namespace'
    )
  }

  plugins.set(plugin.modelType, plugin)

  if (loggingModule && plugin.logging?.namespace && !pluginUsingLoggingModule) {
    loggingModule.setLogger(createAddonLoggerCallback(plugin.logging.namespace))
  }
}

export function registerPlugins(pluginList: readonly QvacPlugin[]): void {
  for (const plugin of pluginList) {
    registerPlugin(plugin)
  }
}

/**
 * Wires the addon logger of a plugin that supplied a resolver, loading the
 * addon on the way. Call it once a model of this type is actually being
 * created: it is the point where the addon is needed anyway, so a host
 * missing that addon's platform package fails the load it asked for instead
 * of failing every plugin registration at startup.
 *
 * A no-op for plugins that passed their module directly — those are already
 * wired by `registerPlugin` — and for a namespace that is already wired,
 * which is how two plugins over one addon (whisper and Parakeet over ASR)
 * share a single `setLogger` call. Also a no-op when the registry was cleared
 * while the addon was loading, so a shutdown that races a load leaves no
 * logger behind.
 */
export async function ensureAddonLoggerReady(plugin: QvacPlugin): Promise<void> {
  const resolver = getLoggingResolver(plugin)
  const namespace = plugin.logging?.namespace
  if (!resolver || !namespace) return
  if (lazyAddonLoggers.has(namespace)) return

  const pending = pendingAddonLoggers.get(namespace)
  if (pending) return pending

  const wiring = (async () => {
    const resolved = unwrapLoggingModule(await resolver())

    // Loading the addon takes real time, and the registry can be torn down
    // while this is parked: `runCleanup` calls `clearRegistries()`
    // synchronously and only then awaits `unloadAllModels()`, so a sweep can
    // pass between the call above and this line. Wiring now would hand the
    // addon a callback nothing will release — on Expo, a `js_ref_t` leaked
    // into a dying isolate, which the next worklet's first `setLogger` trips
    // over. Nothing has been wired yet, so dropping the resolved module is
    // the whole cleanup.
    if (!isNamespaceClaimed(namespace)) return

    const loggingModule = assertLoggingModuleShape(plugin.modelType, resolved)

    for (const [wiredNamespace, wiredModule] of lazyAddonLoggers) {
      if (wiredModule === loggingModule && wiredNamespace !== namespace) {
        throw new PluginLoggingInvalidError(
          plugin.modelType,
          'plugins sharing logging.module must use the same namespace'
        )
      }
    }

    loggingModule.setLogger(createAddonLoggerCallback(namespace))
    lazyAddonLoggers.set(namespace, loggingModule)
  })()

  pendingAddonLoggers.set(namespace, wiring)
  try {
    await wiring
  } finally {
    pendingAddonLoggers.delete(namespace)
  }
}

/** Whether a registered resolver-based plugin still claims this namespace. */
function isNamespaceClaimed(namespace: string): boolean {
  return Array.from(plugins.values()).some(
    (candidate) => getLoggingResolver(candidate) && candidate.logging?.namespace === namespace
  )
}

/** Releases a lazily-wired addon logger once no registered plugin claims it. */
function releaseLazyAddonLogger(namespace: string | undefined, modelType: string): void {
  if (namespace === undefined) return
  const loggingModule = lazyAddonLoggers.get(namespace)
  if (!loggingModule) return
  if (isNamespaceClaimed(namespace)) return

  lazyAddonLoggers.delete(namespace)
  releaseLoggerSafely(loggingModule, modelType)
}

/**
 * Runs an addon's `releaseLogger`. A failure must not abort a sweep or leave
 * the registry half-cleared for the next caller, but it is reported rather
 * than swallowed: a leaked reference or a live async handle must not pass for
 * a clean teardown. `subject` names what is being released — a model type, or
 * a namespace for a logger that is only keyed by one — and `during` names the
 * sweep, when the release is part of one.
 */
function releaseLoggerSafely(
  loggingModule: PluginLoggingModule,
  subject: string,
  during?: string
): void {
  try {
    loggingModule.releaseLogger?.()
  } catch (error) {
    getEngineLogger().warn(
      `[${subject}] releaseLogger failed${during ? ` during ${during}` : ''}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export function getPlugin(modelType: string): QvacPlugin | undefined {
  return plugins.get(modelType)
}

export function getPluginHandler(
  modelType: string,
  handlerName: string
): PluginHandlerDefinition | undefined {
  const plugin = plugins.get(modelType)
  if (!plugin) return undefined
  return plugin.handlers[handlerName]
}

export function hasPlugin(modelType: string): boolean {
  return plugins.has(modelType)
}

export function unregisterPlugin(modelType: string): boolean {
  const plugin = plugins.get(modelType)
  if (!plugin) return false

  const loggingModule = getLoggingModule(plugin)
  const resolverNamespace = getLoggingResolver(plugin) ? plugin.logging?.namespace : undefined
  plugins.delete(modelType)
  if (loggingModule && !findPluginUsingLoggingModule(loggingModule)) {
    loggingModule.releaseLogger?.()
  }
  releaseLazyAddonLogger(resolverNamespace, modelType)

  return true
}

export function getAllPlugins(): QvacPlugin[] {
  return Array.from(plugins.values())
}

export function getTurboVecIndexProvider() {
  return findPluginProvidingTurboVecIndex()?.capabilities?.turbovecIndexProvider
}

export function clearPlugins(): void {
  const loggingModules = new Map<PluginLoggingModule, string>()
  for (const plugin of plugins.values()) {
    const loggingModule = getLoggingModule(plugin)
    if (loggingModule && !loggingModules.has(loggingModule)) {
      loggingModules.set(loggingModule, plugin.modelType)
    }
  }
  const lazyModules = new Map(lazyAddonLoggers)
  plugins.clear()
  lazyAddonLoggers.clear()
  for (const [loggingModule, modelType] of loggingModules) {
    releaseLoggerSafely(loggingModule, modelType, 'clearPlugins')
  }
  // Loggers wired through a resolver are keyed by namespace rather than held
  // on the plugin, so they need the same sweep. They are named by that
  // namespace, which is not a model type — several plugins can share one.
  for (const [namespace, loggingModule] of lazyModules) {
    releaseLoggerSafely(loggingModule, `namespace ${namespace}`, 'clearPlugins')
  }
}
