'use strict'

// One load, one process. Prints a single JSON line and exits.
//
// This runs as its own process for a measured reason: a second load in the same
// process cannot be measured. On the Vulkan backend `unload()` leaves ~190 MB of
// file-backed residency permanently resident, so every delta after the first
// reads short (measured: 373 MB, then 209, then 209 for the same mode), and the
// page cache the first load warms makes every later load faster regardless of
// its mode (756 ms, then 439, then 437). Both effects are order-dependent, so
// modes compared inside one process are compared against different baselines.
//
// The orchestrator (load-mode-sweep.js) spawns one of these per measurement.

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const {
  resolveAddonCtor,
  resolveAddonLogging,
  parseAddonSource,
  parseArgs,
  readMemorySample,
  diffMemorySamples
} = require('./utils')
const { elapsedMs } = require('./math')

const SETTLE_MS = 500
// Engine log lines kept for a failure report. The addon's own error is terse
// ("Failed to initialize model"); the reason — a missing backend, an
// unreadable file — is only in what llama.cpp logged just before it. A
// win32 leg once failed all 36 cells with nothing else to go on.
const ENGINE_LOG_TAIL = 8
const engineLog = []

// --diagnose: also capture llama.cpp's native log, which is where the reason
// for a failed load actually is (the JS logger above only sees the addon's
// own messages). Only the orchestrator's one-off re-run of a failed cell
// passes it, so no measured load pays for native-to-JS log callbacks.
const NATIVE_LOG_TAIL = 30
const NATIVE_PRIORITY = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
const nativeLog = []

function keepLog (level) {
  return (...args) => {
    engineLog.push(`${level}: ${args.map(String).join(' ').trim()}`)
    if (engineLog.length > ENGINE_LOG_TAIL) engineLog.shift()
  }
}

function settle () {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

async function main () {
  const args = parseArgs(process.argv)
  const modelPath = args.model
  if (!modelPath) throw new Error('--model is required')
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'))
  const addonSource = parseAddonSource(args['addon-source'])
  const AddonCtor = resolveAddonCtor(addonSource)
  if (args.diagnose) {
    resolveAddonLogging(addonSource).setLogger((priority, message) => {
      nativeLog.push(`${NATIVE_PRIORITY[priority] || priority}: ${String(message).trim()}`)
      if (nativeLog.length > NATIVE_LOG_TAIL) nativeLog.shift()
    })
    config.verbosity = '2'
  }

  await settle()
  const before = readMemorySample()

  const addon = new AddonCtor({
    files: { model: [path.resolve(modelPath)] },
    config,
    // Buffered, never printed: stdout carries the one JSON result line. Every
    // level is kept because backend-loading failures are not always logged
    // as errors. Storing a string costs nothing measurable next to a load.
    logger: { info: keepLog('info'), warn: keepLog('warn'), error: keepLog('error'), debug: () => {} },
    opts: { stats: true }
  })

  const start = process.hrtime()
  await addon.load()
  const loadMs = elapsedMs(start)

  await settle()
  const afterLoad = readMemorySample()

  // One minimal inference, after the memory sample so it cannot perturb it.
  // Its only purpose is `backendDevice`: an explicit main-gpu naming a class
  // this host lacks falls back to the CPU silently, and without this the row
  // would be filed under the device that was asked for rather than the one
  // that ran. calibrate-model-fit.ts asserts the same thing for the same reason.
  // Two different outcomes, kept apart. A probe that THREW tells us nothing
  // and is a harness fault — swallowing it silently is how an invalid
  // generation param was mistaken for a platform that cannot report its
  // backend. A probe that ran and returned no backendDevice is a genuine
  // reporting gap. Only the second is "unverified".
  let backendDevice = null
  let backendProbeError = null
  try {
    const response = await addon.run([{ role: 'user', content: 'ping' }])
    await response.onUpdate(() => {}).await()
    backendDevice = (response.stats && response.stats.backendDevice) || null
  } catch (err) {
    backendProbeError = (err && err.message) || String(err)
  }

  await addon.unload().catch(() => {})
  await settle()
  const afterUnload = readMemorySample()

  // Both the delta and the absolute post-load figure are reported. The delta is
  // the one to compare across modes; the absolutes let a reader see the
  // baseline it was taken against, and afterUnload exposes what a mode leaves
  // behind — which is how the retained-residency effect above was found.
  console.log(JSON.stringify({
    ok: true,
    loadMs,
    backendDevice,
    backendProbeError,
    delta: diffMemorySamples(before, afterLoad),
    absolute: { before, afterLoad, afterUnload }
  }))
  process.exit(0)
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err)
  let error = engineLog.length ? `${message} — engine log: ${engineLog.join(' | ')}` : message
  if (nativeLog.length) error += ` — native log: ${nativeLog.join(' | ')}`
  console.log(JSON.stringify({ ok: false, error }))
  process.exit(1)
})
