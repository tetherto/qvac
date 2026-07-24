'use strict'

// Multi-addon co-load smoke (Bare entrypoint).
//
// require()s several @qvac ggml addons into ONE Bare process and asserts each
// one loads. Per-addon CI only ever loads a single addon, so it structurally
// cannot catch the class of bug where addon A passes alone, addon B passes
// alone, but A + B crash when both are dlopen'd into the same process -- e.g.
// the @qvac/tts-ggml@0.2.1 unresolved ggml_backend_is_cpu symbol, or two ggml
// copies interposing on each other. The real SDK consumer loads ~10 such
// addons at once (see packages/sdk/server/worker.ts); this is a cheap,
// model-free proxy for that.
//
// Selection via COLOAD_ADDONS (see addons.js#resolveSelection):
//   COLOAD_ADDONS=all                              (default)
//   COLOAD_ADDONS=speech                           (a whole stack)
//   COLOAD_ADDONS=tts-ggml,llm-llamacpp,diffusion-cpp
//
// COLOAD_REQUIRE_INSTALLED=1 makes a fall-back to the monorepo source fatal, so
// CI provably co-loads the installed (PR-overlaid) package and never reports a
// green run that silently tested the checkout instead of the addon.
// COLOAD_CYCLES=N (default 1) runs the model-free reload lifecycle N times for
// addons that opt in via addons.js#lifecycle.

const path = require('bare-path')
const proc = require('bare-process')
const { ADDONS, resolveSelection } = require('../addons.js')
const { coloadOnce, runLifecycle } = require('../coload.js')

// A failed load surfaces either as a synchronous throw from require() or (under
// async module loaders) as an unhandledRejection on the worklet thread. Record
// either and force a non-zero exit on drain so a co-load failure can never be
// reported as a false-green -- the same mistake the addon mobile runners used
// to make.
let coloadFatal = null
function recordFatal (label, err) {
  if (!coloadFatal) coloadFatal = err || new Error(label)
  console.error(`[coload] ${label}:`, err instanceof Error ? err.stack : err)
}

function installExitGuards () {
  const bare = typeof globalThis !== 'undefined' ? globalThis.Bare : undefined
  if (!bare || typeof bare.on !== 'function') return
  bare.on('unhandledRejection', reason => recordFatal('Unhandled rejection during co-load', reason))
  bare.on('uncaughtException', err => recordFatal('Uncaught exception during co-load', err))
  bare.on('beforeExit', () => {
    if (!coloadFatal) return
    console.error('[coload] FATAL: at least one addon failed to co-load.')
    if (typeof bare.exit === 'function') bare.exit(1)
    else proc.exit(1)
  })
}

function parseCycles (raw) {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

const sink = {
  ok (name, specifier, origin) {
    console.log(`[coload] OK   ${name} (${specifier}) [${origin}]`)
  },
  fail (name, specifier, err) {
    recordFatal(`addon ${name} failed`, err)
    console.error(`[coload] FAIL ${name} (${specifier})`)
  },
  cycle (name, cycle) {
    console.log(`[coload] cycle ${cycle} OK ${name}`)
  }
}

function main () {
  installExitGuards()

  const names = resolveSelection(proc.env.COLOAD_ADDONS)
  const deps = {
    addons: ADDONS,
    requireFn: require,
    sourcePathOf: name => path.join(__dirname, '..', '..', name),
    requireInstalled: proc.env.COLOAD_REQUIRE_INSTALLED === '1'
  }

  console.log(`[coload] co-loading ${names.length} addon(s) in one process: ${names.join(', ')}`)
  const loaded = coloadOnce(deps, names, sink)
  const ok = loaded.filter(entry => entry.ok).length
  console.log(`[coload] ${ok}/${names.length} addon(s) co-loaded successfully`)

  const cycles = parseCycles(proc.env.COLOAD_CYCLES)
  const exercised = runLifecycle(deps, loaded, cycles, sink)
  if (exercised.length > 0) {
    console.log(`[coload] ran ${cycles} reload cycle(s) for ${exercised.length} addon(s): ${exercised.map(e => e.name).join(', ')}`)
  }

  // Do not call proc.exit(0): that could race ahead of an async dlopen
  // rejection and mask it. Set exitCode for the synchronous-failure path and
  // let the event loop drain; the beforeExit guard hard-fails on any async
  // error, otherwise Bare exits 0 once the loop is empty.
  if (coloadFatal || ok !== names.length) proc.exitCode = 1
}

main()
