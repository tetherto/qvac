'use strict'

// Multi-addon co-load smoke.
//
// require()s several @qvac ggml addons into ONE Bare process and asserts each
// one loads. Per-addon CI only ever loads a single addon, so it structurally
// cannot catch the class of bug where addon A passes alone, addon B passes
// alone, but A + B crash when both are dlopen'd into the same process -- e.g.
// the @qvac/tts-ggml@0.2.1 unresolved ggml_backend_is_cpu symbol, or two ggml
// copies interposing on each other. The real SDK consumer loads ~10 such
// addons at once (see packages/sdk/server/worker.ts); this is a cheap,
// model-free proxy for that, runnable on every PR.
//
// Selection via COLOAD_ADDONS (see addons.js#resolveSelection):
//   COLOAD_ADDONS=all                              (default)
//   COLOAD_ADDONS=speech                           (a whole stack)
//   COLOAD_ADDONS=tts-ggml,llm-llamacpp,diffusion-cpp

const path = require('bare-path')
const proc = require('bare-process')
const { ADDONS, resolveSelection } = require('../addons.js')

// A failed addon load surfaces either as a synchronous throw from require() or
// (under async module loaders) as an unhandledRejection on the worklet thread.
// Record either and force a non-zero exit on drain so a co-load failure can
// never be reported as a false-green -- the same mistake the addon mobile
// runners used to make.
let _coloadFatal = null
function recordFatal (label, err) {
  if (!_coloadFatal) _coloadFatal = err || new Error(label)
  console.error(`[coload] ${label}:`, err instanceof Error ? err.stack : err)
}

const _bare = typeof globalThis !== 'undefined' ? globalThis.Bare : undefined
if (_bare && typeof _bare.on === 'function') {
  _bare.on('unhandledRejection', (reason) => recordFatal('Unhandled rejection during co-load', reason))
  _bare.on('uncaughtException', (err) => recordFatal('Uncaught exception during co-load', err))
  _bare.on('beforeExit', () => {
    if (!_coloadFatal) return
    console.error('[coload] FATAL: at least one addon failed to co-load.')
    if (typeof _bare.exit === 'function') _bare.exit(1)
    else proc.exit(1)
  })
}

const names = resolveSelection(proc.env.COLOAD_ADDONS)
const packagesDir = path.join(__dirname, '..', '..')

// Prefer the installed package (node_modules) so CI can co-load published
// addons and overlay the PR's freshly-built one; fall back to the monorepo
// source package only when the package itself isn't installed. A genuine
// load / dlopen failure (the bug we hunt) must always propagate, never retry.
function loadAddon (specifier, name) {
  try {
    return require(specifier)
  } catch (err) {
    const msg = String((err && err.message) || err)
    const missing = (err && err.code === 'MODULE_NOT_FOUND') ||
      /cannot find (module|package) '@qvac\//i.test(msg)
    if (!missing) throw err
    return require(path.join(packagesDir, name))
  }
}

console.log(`[coload] co-loading ${names.length} addon(s) in one process: ${names.join(', ')}`)

let loaded = 0
for (const name of names) {
  const info = ADDONS[name]
  try {
    // Requiring the addon runs its binding.js -> require.addon(), which
    // dlopen's the native .bare module -- the exact step that crashed in
    // 0.2.1. loadAddon prefers the installed package, else the source tree.
    const mod = loadAddon(info.specifier, name)
    if (mod == null) throw new Error('module export is null/undefined after require')
    loaded++
    console.log(`[coload] OK   ${name} (${info.specifier})`)
  } catch (err) {
    recordFatal(`addon ${name} failed to load`, err)
    console.error(`[coload] FAIL ${name} (${info.specifier})`)
  }
}

console.log(`[coload] ${loaded}/${names.length} addon(s) co-loaded successfully`)

// Do not call proc.exit(0) here: that could race ahead of an async dlopen
// rejection and mask it. Set exitCode for the synchronous-failure path and let
// the event loop drain; the beforeExit handler hard-fails on any async error,
// otherwise Bare exits 0 naturally once the loop is empty.
if (_coloadFatal || loaded !== names.length) proc.exitCode = 1
