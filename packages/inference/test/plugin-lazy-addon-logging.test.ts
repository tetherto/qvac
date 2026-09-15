import test from 'brittle'
import { z } from 'zod'
import {
  clearPlugins,
  ensureAddonLoggerReady,
  registerPlugin,
  unregisterPlugin
} from '@/plugins/registry'
import { ADDON_ASR } from '@/schemas'

// A plugin may hand the registry a resolver for its addon's logging module
// instead of the module itself. Registration must then not call it: importing
// an addon's `addonLogging` loads its native binding, and since the
// per-platform prebuild split that binding is missing on any host whose
// platform package was not installed. Every addon is an optional peer
// dependency, so one absent addon must not stop the rest from registering —
// it should fail the load that actually needs it.

interface MockLoggingModule {
  setLogger(callback: (priority: number, message: string) => void): void
  releaseLogger(): void
}

function makeLoggingModule() {
  const state = { setCalls: 0, releaseCalls: 0 }
  const module: MockLoggingModule = {
    setLogger() {
      state.setCalls += 1
    },
    releaseLogger() {
      state.releaseCalls += 1
    }
  }
  return { module, state }
}

function makePlugin(modelType: string, module: unknown, namespace: string = ADDON_ASR) {
  return {
    modelType,
    displayName: modelType,
    addonPackage: ADDON_ASR,
    loadConfigSchema: z.object({}),
    createModel() {
      return {
        model: {
          load() {
            return Promise.resolve()
          }
        }
      }
    },
    handlers: {},
    logging: { module, namespace }
  }
}

test('registering a plugin never calls its logging resolver', async (t) => {
  t.teardown(() => clearPlugins())
  let resolverCalls = 0
  const { module, state } = makeLoggingModule()

  registerPlugin(
    makePlugin('lazy-logging-register', () => {
      resolverCalls += 1
      return module
    })
  )

  t.is(resolverCalls, 0, 'the addon is untouched at registration')
  t.is(state.setCalls, 0, 'and its logger is not wired yet')
})

test('an addon that cannot load fails its own load, not registration', async (t) => {
  t.teardown(() => clearPlugins())
  // Stands in for the real failure: the platform package holding the native
  // binding is absent, so importing the addon's logging entry point throws.
  const missingAddon = () => {
    throw new Error('@qvac/tts-ggml found no native prebuild for this host')
  }

  const missing = makePlugin('lazy-logging-missing-addon', missingAddon)
  registerPlugin(missing)
  t.pass('a plugin whose addon is unavailable still registers')

  // One unavailable addon must not stop another from wiring: the worker
  // registers every builtin plugin at startup, so they all share this path.
  const { module, state } = makeLoggingModule()
  const sibling = makePlugin('lazy-logging-sibling', () => module, 'sibling-namespace')
  registerPlugin(sibling)
  await ensureAddonLoggerReady(sibling)
  t.is(state.setCalls, 1, 'an unrelated addon still wires its logger')

  await t.exception(
    () => ensureAddonLoggerReady(missing),
    /no native prebuild/,
    'the failure surfaces when that addon is actually needed'
  )
})

test('the logger is wired once per namespace, however many plugins share it', async (t) => {
  t.teardown(() => clearPlugins())
  const { module, state } = makeLoggingModule()
  let resolverCalls = 0
  const resolver = () => {
    resolverCalls += 1
    return module
  }

  // Whisper and Parakeet both sit over @qvac/asr-ggml and share its namespace.
  const whisper = makePlugin('lazy-logging-whisper', resolver)
  const parakeet = makePlugin('lazy-logging-parakeet', resolver)
  registerPlugin(whisper)
  registerPlugin(parakeet)

  await ensureAddonLoggerReady(whisper)
  await ensureAddonLoggerReady(parakeet)

  t.is(state.setCalls, 1, 'setLogger runs once for the shared addon')
  t.is(resolverCalls, 1, 'and the addon is loaded once')
})

test('concurrent loads of one addon wire its logger exactly once', async (t) => {
  t.teardown(() => clearPlugins())
  const { module, state } = makeLoggingModule()
  let resolverCalls = 0
  const plugin = makePlugin('lazy-logging-concurrent', async () => {
    resolverCalls += 1
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    return module
  })
  registerPlugin(plugin)

  await Promise.all([
    ensureAddonLoggerReady(plugin),
    ensureAddonLoggerReady(plugin),
    ensureAddonLoggerReady(plugin)
  ])

  t.is(resolverCalls, 1, 'the in-flight resolution is shared')
  t.is(state.setCalls, 1, 'so the logger is wired once')
})

test('a lazily wired logger is released when its last plugin unregisters', async (t) => {
  t.teardown(() => clearPlugins())
  const { module, state } = makeLoggingModule()
  const whisper = makePlugin('lazy-logging-release-whisper', () => module)
  const parakeet = makePlugin('lazy-logging-release-parakeet', () => module)
  registerPlugin(whisper)
  registerPlugin(parakeet)
  await ensureAddonLoggerReady(whisper)

  unregisterPlugin('lazy-logging-release-whisper')
  t.is(state.releaseCalls, 0, 'still held while a sibling plugin claims it')

  unregisterPlugin('lazy-logging-release-parakeet')
  t.is(state.releaseCalls, 1, 'released once the last one goes')
})

test('clearPlugins releases lazily wired loggers too', async (t) => {
  const { module, state } = makeLoggingModule()
  const plugin = makePlugin('lazy-logging-clear', () => module)
  registerPlugin(plugin)
  await ensureAddonLoggerReady(plugin)
  t.is(state.setCalls, 1)

  clearPlugins()
  t.is(state.releaseCalls, 1, 'the namespace-keyed logger is swept as well')
})

test('a CommonJS addon resolved through import() is unwrapped', async (t) => {
  t.teardown(() => clearPlugins())
  const { module, state } = makeLoggingModule()
  // `import()` of a CJS addon yields a namespace whose `default` is
  // module.exports, which is where setLogger actually lives.
  const plugin = makePlugin('lazy-logging-cjs', () => ({ default: module }))
  registerPlugin(plugin)

  await ensureAddonLoggerReady(plugin)
  t.is(state.setCalls, 1, 'the default export is used')
})

test('a resolution still in flight when the registry is cleared wires nothing', async (t) => {
  // `runCleanup` in src/runtime/lifecycle.ts calls clearRegistries()
  // synchronously and only then awaits unloadAllModels(), so a load parked on
  // `await resolver()` resumes after the sweep has already passed. Wiring the
  // logger at that point hands the addon a callback into a dying isolate that
  // nothing will ever release.
  const { module, state } = makeLoggingModule()
  let releaseResolver: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    releaseResolver = resolve
  })
  const plugin = makePlugin('lazy-logging-shutdown-race', async () => {
    await gate
    return module
  })
  registerPlugin(plugin)

  const wiring = ensureAddonLoggerReady(plugin)
  // The sweep runs while the resolver is parked, exactly as cleanup does.
  clearPlugins()
  releaseResolver?.()
  await wiring

  t.is(state.setCalls, 0, 'the logger is never wired into a torn-down registry')
  t.is(state.releaseCalls, 0, 'and there is nothing to release')

  clearPlugins()
  t.is(state.releaseCalls, 0, 'a later sweep finds no orphaned logger either')
})
