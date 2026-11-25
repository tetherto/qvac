// Browser counterpart of binding.js: the same native surface (LlamaBinding in
// src/addon.ts) backed by the WebAssembly build in prebuilds/web. Bundlers
// pick it through the "browser" field in package.json. It must run inside a
// Dedicated Worker: one cooperative scheduler step runs at a time, then the
// binding returns to the worker event loop before driving the next step.
//
// Model paths are absolute paths in the origin private file system (OPFS),
// e.g. `/models/qwen.gguf` is `models/qwen.gguf` under
// `navigator.storage.getDirectory()`, or the paths of files registered in this
// Worker for in-place mounting. Each file is mounted read-only into the engine
// without being copied into WebAssembly memory.

const LOG_PRIORITY = { ERROR: 0, WARNING: 1, INFO: 2, DEBUG: 3 }
const MEDIA_STAGE_CHUNK_BYTES = 1024 * 1024
const { ensureMessageCacheDirectories, ensureParentDirectory } = require('./browser/cache-files.js')
const createEngine = require('./browser/create-engine.js')
const { checkLoadFiles, mountLoadFiles } = require('./browser/load-config.js')
const { mountModelFiles, unmountModelFiles } = require('./browser/model-files.js')
const retryableModule = require('./browser/retryable-module.js')
const { prepareRunData } = require('./browser/run-data.js')

let logCallback = null
// The engine runs one call at a time (Asyncify allows a single suspended
// call), so every native call goes through this chain in order.
let queue = Promise.resolve()
let queuedCalls = 0
let legacyActiveJobs = 0
let mountCount = 0
let pumpRunning = false
let pumpScheduled = false
let pumpCursor = 0
const engines = new Set()

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
  engines.add(engine)
  return engine
})

function enqueue(task) {
  queuedCalls++
  const result = queue.then(task)
  const settled = result.finally(() => queuedCalls--)
  queue = settled.catch(() => {})
  return settled
}

function serializeHandle(handle, task) {
  const result = handle.control.then(task)
  handle.control = result.catch(() => {})
  return result
}

function emit(engine, handle, jobId, event, payload) {
  const instance = engine.instances.get(handle)
  if (!instance) return 1
  const job = instance.jobs.get(jobId)
  if (!job) return 1
  if (event === 'Output' || event === 'BatchOutput') {
    try {
      if (event === 'Output') {
        instance.outputCb(instance.owner, 'Output', payload, null, jobId)
      } else {
        // Match the native binding: streaming batch chunks route by their
        // per-prompt string id, while only terminal group events carry jobId.
        instance.outputCb(instance.owner, 'BatchOutput', JSON.parse(payload), null, undefined)
      }
    } catch (error) {
      job.callbackError = error
      job.cancelled = true
    }
  } else if (event === 'BatchResult') {
    job.terminals.push({ event, data: JSON.parse(payload), error: null })
  } else if (event === 'JobEnded') {
    job.ended = true
    job.terminals.push({ event, data: JSON.parse(payload), error: null })
  } else if (event === 'Error') {
    job.ended = true
    job.terminals.push({ event, data: null, error: engineError(payload) })
  }
  return job.cancelled ? 1 : 0
}

function isCancelled(engine, handle, jobId) {
  return engine.instances.get(handle)?.jobs.get(jobId)?.cancelled === true
}

function deliverTerminals(handle, id, job) {
  const engineErrorTerminal = job.terminals.find((terminal) => terminal.event === 'Error')
  const terminals = job.callbackError
    ? [{ event: 'Error', data: null, error: job.callbackError }]
    : engineErrorTerminal
      ? [engineErrorTerminal]
      : job.terminals.length > 0
        ? job.terminals
        : [{ event: 'Error', data: null, error: new Error('Job cancelled') }]
  for (const terminal of terminals) {
    try {
      handle.outputCb(handle.owner, terminal.event, terminal.data, terminal.error, id)
    } catch {}
  }
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
    const status = await module.ccall(name, 'number', types, args, { async: true })
    return check(module, status)
  } catch (error) {
    if (isFatalWasmError(error)) poison(engine, error)
    throw error
  }
}

// Only for exports that never suspend. Under Asyncify a suspended sync ccall
// returns a Promise while the engine is still running, so treat that as fatal
// rather than let the next call in.
function callSync(handle, name, types, args, prepare) {
  const engine = usableEngine(handle)
  const { module } = engine
  try {
    if (prepare) prepare(module)
    const status = module.ccall(name, 'number', types, args)
    if (typeof status?.then === 'function') {
      const error = new Error(`${name} suspended in a synchronous engine call`)
      poison(engine, error)
      throw error
    }
    return check(module, status)
  } catch (error) {
    if (isFatalWasmError(error)) poison(engine, error)
    throw error
  }
}

function validateJob(handle, messages, hasMedia) {
  return callSync(
    handle,
    'qvac_web_validate',
    ['number', 'string', 'number'],
    [handle.native, messages, hasMedia ? 1 : 0]
  )
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

function createInstance(owner, configurationParams, outputCb) {
  const handle = {
    owner,
    outputCb,
    params: configurationParams,
    native: 0,
    jobs: new Map(),
    pendingAdmissions: new Set(),
    nextJobId: 1,
    nextCacheOperationId: 1,
    active: 0,
    activeSlots: 0,
    cooperative: false,
    destroying: false,
    control: Promise.resolve(),
    mounts: [],
    engine: null,
    failure: null
  }
  return handle
}

function activate(handle) {
  return serializeHandle(handle, () =>
    enqueue(async () => {
      const { config } = handle.params
      handle.cooperative = config?.parallel !== undefined && Number(config.parallel) > 1
      checkLoadFiles(handle.params)
      const engine = await loadEngine()
      handle.engine = engine
      // loadEngine() caches a healthy engine across unload/reload cycles. The
      // last unload removes an idle engine from the pump's registry, so make
      // every activation register the cached engine again before it can admit
      // cooperative work.
      engines.add(engine)
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
  )
}

function stageMedia(module, handle, id, media) {
  for (let promptIndex = 0; promptIndex < media.length; promptIndex++) {
    for (let mediaIndex = 0; mediaIndex < media[promptIndex].length; mediaIndex++) {
      const content = media[promptIndex][mediaIndex]
      // ccall's `array` conversion uses the 8 MiB Wasm stack. Append bounded
      // chunks so a valid large image cannot overflow it during staging.
      const chunks = Math.max(1, Math.ceil(content.byteLength / MEDIA_STAGE_CHUNK_BYTES))
      for (let chunk = 0; chunk < chunks; chunk++) {
        const start = chunk * MEDIA_STAGE_CHUNK_BYTES
        const bytes = content.subarray(
          start,
          Math.min(start + MEDIA_STAGE_CHUNK_BYTES, content.byteLength)
        )
        check(
          module,
          module.ccall(
            'qvac_web_stage_media',
            'number',
            ['number', 'number', 'number', 'number', 'array', 'number'],
            [handle.native, id, promptIndex, mediaIndex, bytes, bytes.byteLength]
          )
        )
      }
    }
  }
}

function createJob(handle, id, legacy = false, reserved = false) {
  let resolveSettled
  const settled = new Promise((resolve) => {
    resolveSettled = resolve
  })
  const job = {
    cancelled: false,
    ended: false,
    submitted: false,
    terminals: [],
    callbackError: null,
    legacy,
    settled,
    resolveSettled
  }
  handle.jobs.set(id, job)
  handle.active++
  if (legacy && !reserved) legacyActiveJobs++
  return job
}

function allocateJobId(handle) {
  const first = handle.nextJobId
  do {
    const id = handle.nextJobId
    handle.nextJobId = id === 0x7fffffff ? 1 : id + 1
    if (!handle.jobs.has(id)) return id
  } while (handle.nextJobId !== first)
  throw new Error('No browser job ids are available')
}

function finishJob(handle, id, fallbackError = null, deliver = true) {
  const job = handle.jobs.get(id)
  if (!job) return
  if (!job.ended && fallbackError) {
    job.ended = true
    job.terminals.push({ event: 'Error', data: null, error: fallbackError })
  }
  handle.jobs.delete(id)
  handle.active--
  if (job.legacy) legacyActiveJobs--
  job.resolveSettled()
  if (deliver) deliverTerminals(handle, id, job)
}

function cleanupEnded(handle) {
  for (const [id, job] of handle.jobs) {
    if (job.ended) finishJob(handle, id)
  }
}

function cooperativeHandles() {
  const handles = []
  for (const engine of engines) {
    for (const handle of engine.handles) {
      if (handle.cooperative && handle.native !== 0 && handle.jobs.size > 0) handles.push(handle)
    }
  }
  return handles
}

function schedulePump() {
  if (pumpRunning || pumpScheduled) return
  pumpScheduled = true
  setTimeout(() => {
    pumpScheduled = false
    void runPump()
  }, 0)
}

async function runPump() {
  if (pumpRunning) return
  pumpRunning = true
  try {
    while (true) {
      const handles = cooperativeHandles()
      if (handles.length === 0) break
      const handle = handles[pumpCursor % handles.length]
      pumpCursor = (pumpCursor + 1) % Math.max(handles.length, 1)
      try {
        await enqueue(async () => {
          await call(handle, 'qvac_web_step', ['number'], [handle.native])
          handle.activeSlots = callSync(
            handle,
            'qvac_web_active_slots',
            ['number'],
            [handle.native]
          )
        })
        cleanupEnded(handle)
      } catch (error) {
        handle.activeSlots = 0
        // A job still queued behind this step has not reached the engine and
        // its caller has no listener yet; it is submitted after the step.
        for (const [id, job] of [...handle.jobs]) {
          if (job.submitted) finishJob(handle, id, error)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    pumpRunning = false
    if (cooperativeHandles().length > 0) schedulePump()
  }
}

function runLegacyJob(handle, id, job, prepared) {
  const execution = enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      if (!job.cancelled) {
        await call(
          handle,
          'qvac_web_run',
          ['number', 'number', 'string'],
          [handle.native, id, prepared.json],
          (module) => {
            ensureMessageCacheDirectories(module, prepared.json)
            stageMedia(module, handle, id, prepared.media)
          }
        )
      }
    } catch (error) {
      if (!job.ended) {
        job.ended = true
        job.terminals.push({ event: 'Error', data: null, error })
      }
    }
  })
  execution.then(() => finishJob(handle, id))
}

function runJob(handle, data, rejectWhenBusy = false) {
  if (handle.destroying) return Promise.reject(new Error('Model is not loaded'))
  const isBatch = data.length > 0 && Array.isArray(data[0].messages)
  if (isBatch && !handle.cooperative) {
    return Promise.reject(new Error('Batch run() requires the model loaded with parallel >= 2'))
  }
  const prepared = prepareRunData(data)
  if (!handle.cooperative && rejectWhenBusy && legacyActiveJobs > 0) {
    return Promise.reject(busyError())
  }
  if (!handle.cooperative) {
    const pending = { cancelled: false }
    handle.pendingAdmissions.add(pending)
    legacyActiveJobs++
    return serializeHandle(handle, () =>
      enqueue(() => {
        try {
          if (pending.cancelled || handle.destroying) throw new Error('Job cancelled')
          validateJob(
            handle,
            prepared.json,
            prepared.media.some((media) => media.length > 0)
          )
        } catch (error) {
          handle.pendingAdmissions.delete(pending)
          legacyActiveJobs--
          throw error
        }
        handle.pendingAdmissions.delete(pending)
        const id = allocateJobId(handle)
        const job = createJob(handle, id, true, true)
        runLegacyJob(handle, id, job, prepared)
        return { accepted: true, id }
      })
    )
  }

  const id = allocateJobId(handle)
  const job = createJob(handle, id)

  return serializeHandle(handle, () =>
    enqueue(async () => {
      try {
        await call(
          handle,
          'qvac_web_submit',
          ['number', 'number', 'number', 'string'],
          [handle.native, id, isBatch ? 1 : 0, prepared.json],
          (module) => {
            ensureMessageCacheDirectories(module, prepared.json)
            stageMedia(module, handle, id, prepared.media)
          }
        )
        job.submitted = true
        if (job.cancelled) {
          callSync(handle, 'qvac_web_cancel_job', ['number', 'number'], [handle.native, id])
        }
        handle.activeSlots = callSync(handle, 'qvac_web_active_slots', ['number'], [handle.native])
      } catch (error) {
        finishJob(handle, id, null, false)
        throw error
      }
      schedulePump()
      return isBatch ? { accepted: true, id, ids: prepared.ids } : { accepted: true, id }
    })
  )
}

async function cancelJob(handle, id) {
  if (id === undefined || id === null) return cancel(handle)
  const job = handle.jobs.get(id)
  if (!job) return
  job.cancelled = true
  if (handle.cooperative && handle.native) {
    await enqueue(() =>
      callSync(handle, 'qvac_web_cancel_job', ['number', 'number'], [handle.native, id])
    )
    schedulePump()
  }
  await job.settled
}

function cancel(handle) {
  for (const pending of handle.pendingAdmissions) pending.cancelled = true
  const ids = [...handle.jobs.keys()]
  return Promise.all(ids.map((id) => cancelJob(handle, id))).then(() => {})
}

function cacheOperation(handle, cacheKey, discard) {
  if (!handle.cooperative) {
    return enqueue(() =>
      call(
        handle,
        discard ? 'qvac_web_discard_cache' : 'qvac_web_save_cache',
        ['number', 'string'],
        [handle.native, cacheKey],
        discard ? undefined : (module) => ensureParentDirectory(module, cacheKey)
      )
    )
  }
  return serializeHandle(handle, async () => {
    const operationId = handle.nextCacheOperationId++
    // A cooperative save runs in this call and reads state back from the GPU,
    // which can suspend.
    await enqueue(async () => {
      const module = usableEngine(handle).module
      if (!discard) ensureParentDirectory(module, cacheKey)
      await call(
        handle,
        'qvac_web_cache_request',
        ['number', 'number', 'string', 'number'],
        [handle.native, operationId, cacheKey, discard ? 1 : 0]
      )
    })
    schedulePump()
    while (true) {
      const status = await enqueue(() =>
        callSync(handle, 'qvac_web_cache_poll', ['number', 'number'], [handle.native, operationId])
      )
      if (status === 0) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })
}

// Queued behind any running job, so the job still emits its terminal event.
function destroyInstance(handle) {
  handle.destroying = true
  if (
    !handle.native &&
    handle.mounts.length === 0 &&
    handle.jobs.size === 0 &&
    handle.pendingAdmissions.size === 0
  ) {
    handle.engine?.handles.delete(handle)
    handle.engine = null
    return Promise.resolve()
  }
  return cancel(handle).then(() =>
    serializeHandle(handle, () =>
      enqueue(async () => {
        // Read the resources only after earlier queued work has settled. In
        // particular, unload may be requested while activate() is still creating
        // the native instance and mounting its files.
        const engine = handle.engine
        const native = handle.native
        if (native && !handle.failure) {
          try {
            // Destroying flushes resident caches, reading state back from the
            // GPU, which can suspend.
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
            if (!handle.failure) cleanupError = error
            if (handle.failure) handle.mounts.length = 0
          }
        }
        if (cleanupError) throw cleanupError
        engine?.handles.delete(handle)
        if (engine?.handles.size === 0) engines.delete(engine)
        handle.engine = null
      })
    )
  )
}

module.exports = {
  createInstance,
  activate,
  runJob,
  cancel,
  cancelJob,
  destroyInstance,
  activeJobs: (handle) => handle.active,
  activeSlots: (handle) => handle.activeSlots,
  assessFit: () => unsupported('assessFit'),
  saveCache: (handle, cacheKey) => cacheOperation(handle, cacheKey, false),
  discardCache: (handle, cacheKey) => cacheOperation(handle, cacheKey, true),
  calcTokens: (handle, params) => {
    if (queuedCalls > 0 || handle.active > 0) return Promise.reject(busyError())
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
