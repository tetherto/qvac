// Browser counterpart of binding.js: the same native surface (LlamaBinding in
// src/addon.ts) backed by the WebAssembly build in prebuilds/web. Bundlers
// pick it through the "browser" field in package.json. It must run inside a
// Dedicated Worker: the engine blocks its caller between GPU waits.
//
// Model paths are absolute paths in the origin private file system (OPFS),
// e.g. `/models/qwen.gguf` is `models/qwen.gguf` under
// `navigator.storage.getDirectory()`, or the paths of files the page mounted
// in place. Each file is mounted read-only into the engine without being
// copied into WebAssembly memory.

const LOG_PRIORITY = { ERROR: 0, WARNING: 1, INFO: 2, DEBUG: 3 }
const { ensureMessageCacheDirectories, ensureParentDirectory } = require('./browser/cache-files.js')
const { mountLoadFiles } = require('./browser/load-config.js')
const { mountModelFiles, unmountModelFiles } = require('./browser/model-files.js')
const retryableModule = require('./browser/retryable-module.js')

let logCallback = null
// The engine runs one call at a time (Asyncify allows a single suspended
// call), so every native call goes through this chain in order.
let queue = Promise.resolve()
let queuedCalls = 0
let activeJobCount = 0
let mountCount = 0
const instances = new Map()

function log(line, fallback) {
  const match = /^\[(ERROR|WARNING|INFO|DEBUG)\]: ?([\s\S]*)$/.exec(line)
  const priority = match ? LOG_PRIORITY[match[1]] : fallback
  const message = match ? match[2] : line
  if (logCallback && message.trim() !== '') logCallback(priority, message)
}

// A module that declares one page of 64-bit memory: it validates only where
// WebAssembly Memory64 is supported.
const MEMORY64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])

// Both imports stay literal so bundlers emit both engine variants.
function importEngine() {
  if (WebAssembly.validate(MEMORY64_PROBE)) {
    return import('./prebuilds/web/llm-llamacpp-64.mjs')
  }
  return import('./prebuilds/web/llm-llamacpp.mjs')
}

const loadModule = retryableModule(() =>
  importEngine().then(({ default: createModule }) =>
    createModule({
      print: (line) => log(line, LOG_PRIORITY.INFO),
      printErr: (line) => log(line, LOG_PRIORITY.WARNING),
      qvacEmit: (handle, jobId, event, payload) => emit(handle, jobId, event, payload)
    })
  )
)

function enqueue(task) {
  queuedCalls++
  const result = queue.then(task)
  const settled = result.finally(() => queuedCalls--)
  queue = settled.catch(() => {})
  return settled
}

function emit(handle, jobId, event, payload) {
  const instance = instances.get(handle)
  if (!instance) return 1
  const job = instance.jobs.get(jobId)
  if (job && (event === 'JobEnded' || event === 'Error')) job.ended = true
  if (event === 'Output') {
    instance.outputCb(instance.owner, 'Output', payload, null, jobId)
  } else if (event === 'JobEnded') {
    instance.outputCb(instance.owner, 'JobEnded', JSON.parse(payload), null, jobId)
  } else if (event === 'Error') {
    instance.outputCb(instance.owner, 'Error', null, engineError(payload), jobId)
  }
  return job && job.cancelled ? 1 : 0
}

function engineError(payload) {
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return new Error(payload)
  }
  const error = new Error(parsed.error)
  if (parsed.code) error.code = parsed.code
  return error
}

function check(module, status) {
  if (status < 0) {
    throw engineError(module.ccall('qvac_web_result', 'string'))
  }
  return status
}

async function call(name, types, args, prepare) {
  const module = await loadModule()
  if (prepare) prepare(module)
  const status = await module.ccall(name, 'number', types, args, {
    async: true
  })
  return check(module, status)
}

// Mounts one model, including all sibling GGUF shards, read-only and returns
// the primary file's path inside the engine.
function mount(module, handle, path) {
  const mountpoint = `/qvac-files/${++mountCount}`
  return mountModelFiles(module, handle.mounts, mountpoint, path)
}

function unsupported(name) {
  return Promise.reject(new Error(`${name} is not supported in the browser build`))
}

function busyError() {
  const error = new Error('Cannot set new job: a job is already set or being processed')
  error.code = 'RUN_BUSY'
  return error
}

function containsMedia(data) {
  for (const item of data) {
    if (item.type === 'media') return true
    if (item.type !== 'text' || typeof item.input !== 'string') continue
    let messages
    try {
      messages = JSON.parse(item.input)
    } catch {
      continue
    }
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      if (message.type === 'media') return true
      if (
        Array.isArray(message.content) &&
        message.content.some((part) => part && typeof part === 'object' && part.type === 'media')
      ) {
        return true
      }
    }
  }
  return false
}

function createInstance(owner, configurationParams, outputCb) {
  const handle = {
    owner,
    outputCb,
    params: configurationParams,
    native: 0,
    jobs: new Map(),
    nextJobId: 1,
    active: 0,
    mounts: []
  }
  return handle
}

function activate(handle) {
  return enqueue(async () => {
    const module = await loadModule()
    const { config } = handle.params
    if (config && config.parallel !== undefined && String(config.parallel) !== '1') {
      throw new Error('parallel > 1 is not supported in the browser build')
    }
    const files = await mountLoadFiles(handle.params, (filePath) => mount(module, handle, filePath))
    handle.native = check(
      module,
      module.ccall(
        'qvac_web_create',
        'number',
        ['string', 'string', 'string'],
        [files.modelPath, files.projectionPath, JSON.stringify(files.config)]
      )
    )
    instances.set(handle.native, handle)
    await call('qvac_web_activate', ['number'], [handle.native])
  })
}

function runJob(handle, data) {
  if (data.length > 0 && Array.isArray(data[0].messages)) {
    return unsupported('Batch inference')
  }
  if (containsMedia(data)) {
    return unsupported('Media input')
  }
  const messages = JSON.stringify(data, (key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`${key || 'value'} must be a finite number`)
    }
    return value
  })
  const id = handle.nextJobId++
  const job = { cancelled: false, ended: false }
  handle.jobs.set(id, job)
  handle.active++
  activeJobCount++
  // The caller registers its output sink for `id` only after this admission
  // promise settles, so the job starts on a later task: the engine can emit
  // its first token before yielding (always so on CPU).
  enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      if (!job.cancelled) {
        await call(
          'qvac_web_run',
          ['number', 'number', 'string'],
          [handle.native, id, messages],
          (module) => ensureMessageCacheDirectories(module, messages)
        )
      }
    } catch (error) {
      // The engine reports its own failures as an Error event; this covers a
      // call that failed before reaching it.
      if (!job.ended) {
        job.ended = true
        handle.outputCb(handle.owner, 'Error', null, error, id)
      }
    } finally {
      try {
        // Every admitted job ends with exactly one terminal event.
        if (!job.ended) {
          job.ended = true
          handle.outputCb(handle.owner, 'Error', null, new Error('Job cancelled'), id)
        }
      } finally {
        handle.jobs.delete(id)
        handle.active--
        activeJobCount--
      }
    }
  })
  return Promise.resolve({ accepted: true, id })
}

function cancelJob(handle, id) {
  if (id === undefined || id === null) return cancel(handle)
  const job = handle.jobs.get(id)
  if (job) job.cancelled = true
  return Promise.resolve()
}

function cancel(handle) {
  for (const job of handle.jobs.values()) job.cancelled = true
  return Promise.resolve()
}

// Queued behind any running job, so the job still emits its terminal event.
function destroyInstance(handle) {
  cancel(handle)
  return enqueue(async () => {
    // Read the resources only after earlier queued work has settled. In
    // particular, unload may be requested while activate() is still creating
    // the native instance and mounting its files.
    const native = handle.native
    handle.native = 0
    instances.delete(native)
    if (native) await call('qvac_web_destroy', ['number'], [native])
    const module = await loadModule()
    unmountModelFiles(module, handle.mounts)
  })
}

module.exports = {
  createInstance,
  activate,
  runJob,
  cancel,
  cancelJob,
  destroyInstance,
  // Asyncify permits only one suspended engine call in the worker, so a job
  // admitted by any model makes every model busy for admission purposes.
  activeJobs: () => activeJobCount,
  activeSlots: () => 0,
  assessFit: () => unsupported('assessFit'),
  saveCache: (handle, cacheKey) =>
    enqueue(() =>
      call('qvac_web_save_cache', ['number', 'string'], [handle.native, cacheKey], (module) =>
        ensureParentDirectory(module, cacheKey)
      )
    ),
  discardCache: (handle, cacheKey) =>
    enqueue(() => call('qvac_web_discard_cache', ['number', 'string'], [handle.native, cacheKey])),
  calcTokens: (handle, params) => {
    if (queuedCalls > 0) return Promise.reject(busyError())
    return enqueue(() =>
      call('qvac_web_calc_tokens', ['number', 'string'], [handle.native, JSON.stringify(params)])
    )
  },
  setLogger: (callback) => {
    logCallback = callback
  },
  releaseLogger: () => {
    logCallback = null
  }
}
