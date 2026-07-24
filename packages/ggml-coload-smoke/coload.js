'use strict'

// Testable core of the multi-addon co-load smoke. The Bare entrypoint
// (test/coload.test.js) wires the host `require`, environment, addon registry
// and process handlers to these pure functions; the unit tests
// (test/coload.unit.test.js) drive them with fake modules under Node. Keeping
// the logic here (no Bare globals, registry injected via deps.addons) is what
// makes the false-green guards and the reload cycle testable without a device
// or a real addon.

const DISPOSE_CANDIDATES = ['destroy', 'unload', 'close', 'dispose', 'free']

function isMissingModuleError (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') return true
  const message = String((err && err.message) || err)
  return /cannot find (module|package) '@qvac\//i.test(message)
}

function ctorOf (mod) {
  return (mod && mod.default) ? mod.default : mod
}

function lifecycleOf (addons, name) {
  const info = addons[name]
  return (info && info.lifecycle) || null
}

// Resolve an addon, preferring the installed package (node_modules) so CI can
// overlay the PR's freshly-built prebuild onto the published baseline. When
// deps.requireInstalled is set, a missing package is fatal rather than silently
// falling back to the monorepo source: a co-load that never loaded the PR's
// package must never report green (the false-green the mobile runners once hit).
function loadAddon (deps, specifier, name) {
  try {
    return { mod: deps.requireFn(specifier), origin: 'installed' }
  } catch (err) {
    if (!isMissingModuleError(err)) throw err
    if (deps.requireInstalled) {
      throw new Error(
        `addon '${specifier}' is not installed and COLOAD_REQUIRE_INSTALLED is set; ` +
        'refusing to fall back to monorepo source (the co-load must exercise the ' +
        'installed/overlaid package, not the checkout)'
      )
    }
    return { mod: deps.requireFn(deps.sourcePathOf(name)), origin: 'source' }
  }
}

function coloadAddon (deps, name, sink) {
  const info = deps.addons[name]
  try {
    const { mod, origin } = loadAddon(deps, info.specifier, name)
    if (mod == null) throw new Error('module export is null/undefined after require')
    sink.ok(name, info.specifier, origin)
    return { name, mod, origin, ok: true }
  } catch (err) {
    sink.fail(name, info.specifier, err)
    return { name, mod: null, origin: null, ok: false }
  }
}

// dlopen every selected addon into this one process. Requiring the addon runs
// its binding.js -> require.addon(), which dlopen's the native .bare module --
// the exact step that crashed in @qvac/tts-ggml@0.2.1.
function coloadOnce (deps, names, sink) {
  return names.map(name => coloadAddon(deps, name, sink))
}

function constructInstance (mod, spec) {
  const Ctor = ctorOf(mod)
  if (typeof Ctor !== 'function') throw new Error('addon export is not constructible for a lifecycle cycle')
  return new Ctor(...(spec.ctorArgs || []))
}

function disposeMethodName (instance, spec) {
  if (spec.dispose) return spec.dispose
  return DISPOSE_CANDIDATES.find(name => instance && typeof instance[name] === 'function')
}

function disposeInstance (instance, spec) {
  const name = disposeMethodName(instance, spec)
  if (!name || typeof instance[name] !== 'function') {
    throw new Error(`no model-free dispose method on instance (tried ${spec.dispose || DISPOSE_CANDIDATES.join('/')})`)
  }
  return instance[name]()
}

function reloadInstance (deps, entry, cycle, sink) {
  const spec = lifecycleOf(deps.addons, entry.name)
  try {
    const instance = constructInstance(entry.mod, spec)
    disposeInstance(instance, spec)
    sink.cycle(entry.name, cycle)
  } catch (err) {
    sink.fail(entry.name, deps.addons[entry.name].specifier, err)
  }
}

function cycleOnce (deps, targets, cycle, sink) {
  for (const entry of targets) reloadInstance(deps, entry, cycle, sink)
}

function lifecycleTargets (deps, loaded) {
  return loaded.filter(entry => entry.ok && lifecycleOf(deps.addons, entry.name))
}

// Model-free reload lifecycle. For each co-loaded addon that opts in via
// addons.js#lifecycle (a model-free construct + teardown), build and dispose an
// instance `cycles` times, round-robin across addons, so one addon's ggml
// teardown/re-init is interleaved with the others' -- the load/unload analogue
// of the concurrent load, without model weights. Addons without a descriptor
// are co-loaded only; a throw is recorded, never swallowed. Real, model-driven
// load/unload (with weights) belongs in the SDK e2e (see README).
function runLifecycle (deps, loaded, cycles, sink) {
  const targets = lifecycleTargets(deps, loaded)
  if (targets.length === 0 || cycles < 1) return targets
  for (let cycle = 0; cycle < cycles; cycle++) cycleOnce(deps, targets, cycle, sink)
  return targets
}

module.exports = {
  isMissingModuleError,
  loadAddon,
  coloadAddon,
  coloadOnce,
  runLifecycle,
  lifecycleTargets
}
