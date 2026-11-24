// Browser counterpart of binding.js: the same native surface (LlamaBinding in
// src/addon.ts) backed by the WebAssembly build in prebuilds/web. Bundlers
// pick it through the "browser" field in package.json. It must run inside a
// Dedicated Worker: the engine blocks its caller between GPU waits.
//
// Model paths are absolute paths in the origin private file system (OPFS),
// e.g. `/models/qwen.gguf` is `models/qwen.gguf` under
// `navigator.storage.getDirectory()`. Each file is mounted read-only into the
// engine without being copied into WebAssembly memory.

const LOG_PRIORITY = { ERROR: 0, WARNING: 1, INFO: 2, DEBUG: 3 }
const { ensureMessageCacheDirectories, ensureParentDirectory } = require('./browser/cache-files.js')
const createEngine = require('./browser/create-engine.js')
const { browserLoadConfig, mountLoadFiles } = require('./browser/load-config.js')
const { mountModelFiles, unmountModelFiles } = require('./browser/model-files.js')
const retryableModule = require('./browser/retryable-module.js')

let logCallback = null
// The engine runs one call at a time (Asyncify allows a single suspended
// call), so every native call goes through this chain in order.
let queue = Promise.resolve()
let queuedCalls = 0
let activeJobCount = 0
let mountCount = 0

function log(line, fallback) {
  const match = /^\[(ERROR|WARNING|INFO|DEBUG)\]: ?([\s\S]*)$/.exec(line)
  const priority = match ? LOG_PRIORITY[match[1]] : fallback
  const message = match ? match[2] : line
  if (logCallback && message.trim() !== '') logCallback(priority, message)
}

const loadEngine = retryableModule(async () => {
  const engine = { module: null, handles: new Set(), instances: new Map(), failure: null }
  engine.module = await createEngine({
    print: (line) => log(line, LOG_PRIORITY.INFO),
    printErr: (line) => log(line, LOG_PRIORITY.WARNING),
    qvacEmit: (handle, jobId, event, payload) => emit(engine, handle, jobId, event, payload),
    qvacCancelled: (handle, jobId) => isCancelled(engine, handle, jobId)
  })
  return engine
})

function enqueue(task) {
  queuedCalls++
  const result = queue.then(task)
  const settled = result.finally(() => queuedCalls--)
  queue = settled.catch(() => {})
  return settled
}

function emit(engine, handle, jobId, event, payload) {
  const instance = engine.instances.get(handle)
  if (!instance) return 1
  const job = instance.jobs.get(jobId)
  if (event === 'Output') {
    try {
      instance.outputCb(instance.owner, 'Output', payload, null, jobId)
    } catch (error) {
      if (job) {
        job.callbackError = error
        job.cancelled = true
      }
    }
  } else if (event === 'JobEnded') {
    if (job && !job.terminal) job.terminal = { event, data: JSON.parse(payload), error: null }
  } else if (event === 'Error') {
    if (job && !job.terminal) job.terminal = { event, data: null, error: engineError(payload) }
  }
  return job && job.cancelled ? 1 : 0
}

function isCancelled(engine, handle, jobId) {
  return engine.instances.get(handle)?.jobs.get(jobId)?.cancelled === true
}

function deliverTerminal(handle, id, job) {
  const terminal = job.callbackError
    ? { event: 'Error', data: null, error: job.callbackError }
    : (job.terminal ?? { event: 'Error', data: null, error: new Error('Job cancelled') })
  try {
    handle.outputCb(handle.owner, terminal.event, terminal.data, terminal.error, id)
  } catch {}
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

function engineFailure(error) {
  const failure = new Error('The WebAssembly engine terminated and this model must be loaded again')
  failure.cause = error
  return failure
}

function poison(engine, error) {
  if (!engine.failure) {
    engine.failure = engineFailure(error)
    for (const handle of engine.handles) handle.failure = engine.failure
    engine.instances.clear()
  }
  loadEngine.reset()
}

function isFatalWasmError(error) {
  return error instanceof WebAssembly.RuntimeError || error?.name === 'RuntimeError'
}

function usableEngine(handle) {
  if (handle.failure) throw handle.failure
  if (!handle.engine) throw new Error('Model is not loaded')
  return handle.engine
}

async function call(handle, name, types, args, prepare) {
  const engine = usableEngine(handle)
  const { module } = engine
  try {
    if (prepare) prepare(module)
    const status = await module.ccall(name, 'number', types, args, {
      async: true
    })
    return check(module, status)
  } catch (error) {
    if (isFatalWasmError(error)) poison(engine, error)
    throw error
  }
}

function validateJob(handle, messages) {
  const engine = usableEngine(handle)
  const { module } = engine
  try {
    return check(
      module,
      module.ccall('qvac_web_validate', 'number', ['number', 'string'], [handle.native, messages])
    )
  } catch (error) {
    if (isFatalWasmError(error)) poison(engine, error)
    throw error
  }
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
    pendingAdmissions: new Set(),
    nextJobId: 1,
    active: 0,
    mounts: [],
    engine: null,
    failure: null,
    destroying: false
  }
  return handle
}

function activate(handle) {
  return enqueue(async () => {
    const { config } = handle.params
    if (config && config.parallel !== undefined && String(config.parallel) !== '1') {
      throw new Error('parallel > 1 is not supported in the browser build')
    }
    browserLoadConfig(config)
    const engine = await loadEngine()
    handle.engine = engine
    engine.handles.add(handle)
    const { module } = engine
    try {
      const files = await mountLoadFiles(handle.params, (filePath) =>
        mount(module, handle, filePath)
      )
      handle.native = check(
        module,
        module.ccall(
          'qvac_web_create',
          'number',
          ['string', 'string', 'string'],
          [files.modelPath, files.projectionPath, JSON.stringify(files.config)]
        )
      )
      engine.instances.set(handle.native, handle)
      await call(handle, 'qvac_web_activate', ['number'], [handle.native])
    } catch (error) {
      if (isFatalWasmError(error)) poison(engine, error)
      throw error
    }
  })
}

function runJob(handle, data) {
  if (handle.destroying) return Promise.reject(new Error('Model is not loaded'))
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
  let resolveAdmission
  let rejectAdmission
  const admission = new Promise((resolve, reject) => {
    resolveAdmission = resolve
    rejectAdmission = reject
  })
  let id
  let job
  let admissionError
  const pending = { cancelled: false }
  handle.pendingAdmissions.add(pending)
  activeJobCount++
  const execution = enqueue(async () => {
    try {
      if (pending.cancelled) throw new Error('Job cancelled')
      validateJob(handle, messages)
      handle.pendingAdmissions.delete(pending)
      id = handle.nextJobId++
      job = { cancelled: false, terminal: null, callbackError: null }
      handle.jobs.set(id, job)
      handle.active++
      resolveAdmission({ accepted: true, id })
    } catch (error) {
      handle.pendingAdmissions.delete(pending)
      activeJobCount--
      admissionError = error
      return
    }
    // The caller registers its output sink for `id` only after the admission
    // promise settles, so yield before the engine can emit its first token.
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      if (!job.cancelled) {
        await call(
          handle,
          'qvac_web_run',
          ['number', 'number', 'string'],
          [handle.native, id, messages],
          (module) => ensureMessageCacheDirectories(module, messages)
        )
      }
    } catch (error) {
      // The engine reports its own failures as an Error event; this covers a
      // call that failed before reaching it.
      if (!job.terminal) job.terminal = { event: 'Error', data: null, error }
    } finally {
      handle.jobs.delete(id)
      handle.active--
      activeJobCount--
    }
  })
  execution.then(() => {
    if (job) {
      deliverTerminal(handle, id, job)
    } else {
      rejectAdmission(admissionError)
    }
  })
  return admission
}

function cancelJob(handle, id) {
  if (id === undefined || id === null) return cancel(handle)
  const job = handle.jobs.get(id)
  if (job) job.cancelled = true
  return Promise.resolve()
}

function cancel(handle) {
  for (const job of handle.jobs.values()) job.cancelled = true
  for (const pending of handle.pendingAdmissions) pending.cancelled = true
  return Promise.resolve()
}

// Queued behind any running job, so the job still emits its terminal event.
function destroyInstance(handle) {
  handle.destroying = true
  cancel(handle)
  if (!handle.native && handle.mounts.length === 0 && handle.jobs.size === 0) {
    handle.engine?.handles.delete(handle)
    handle.engine = null
    return Promise.resolve()
  }
  return enqueue(async () => {
    // Read the resources only after earlier queued work has settled. In
    // particular, unload may be requested while activate() is still creating
    // the native instance and mounting its files.
    const engine = handle.engine
    const native = handle.native
    if (native && !handle.failure) {
      try {
        await call(handle, 'qvac_web_destroy', ['number'], [native])
      } catch (error) {
        if (!handle.failure) throw error
      }
    }
    handle.native = 0
    engine?.instances.delete(native)
    let cleanupError = null
    const module = engine?.module
    if (module) {
      try {
        unmountModelFiles(module, handle.mounts)
      } catch (error) {
        if (!handle.failure && !cleanupError) cleanupError = error
        if (handle.failure) handle.mounts.length = 0
      }
    }
    if (cleanupError) throw cleanupError
    engine?.handles.delete(handle)
    handle.engine = null
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
      call(
        handle,
        'qvac_web_save_cache',
        ['number', 'string'],
        [handle.native, cacheKey],
        (module) => ensureParentDirectory(module, cacheKey)
      )
    ),
  discardCache: (handle, cacheKey) =>
    enqueue(() =>
      call(handle, 'qvac_web_discard_cache', ['number', 'string'], [handle.native, cacheKey])
    ),
  calcTokens: (handle, params) => {
    if (queuedCalls > 0) return Promise.reject(busyError())
    return enqueue(() =>
      call(
        handle,
        'qvac_web_calc_tokens',
        ['number', 'string'],
        [handle.native, JSON.stringify(params)]
      )
    )
  },
  setLogger: (callback) => {
    logCallback = callback
  },
  releaseLogger: () => {
    logCallback = null
  },
  _setEngineFactoryForTest: (factory) => {
    createEngine.setFactory(factory)
    loadEngine.reset()
  }
}
