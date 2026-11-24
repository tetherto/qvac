// Browser counterpart of binding.js: the same native surface (LlamaBinding in
// src/addon.ts) backed by the WebAssembly build in prebuilds/web. Bundlers
// pick it through the "browser" field in package.json. It must run inside a
// Dedicated Worker: one cooperative scheduler step runs at a time, then the
// binding returns to the worker event loop before driving the next step.
//
// Model inputs use absolute OPFS or mounted-file paths. Persistent output,
// cache, and checkpoint paths may be relative or absolute; both forms resolve
// beneath navigator.storage.getDirectory(). Model files are mounted read-only
// into the engine without being copied into WebAssembly memory.

const LOG_PRIORITY = { ERROR: 0, WARNING: 1, INFO: 2, DEBUG: 3 }
const MEDIA_STAGE_CHUNK_BYTES = 1024 * 1024
const { ensureMessageCacheDirectories, ensureParentDirectory } = require('./browser/cache-files.js')
const createEngine = require('./browser/create-engine.js')
const { validateFitRequest } = require('./browser/fit.js')
const { browserLoadConfig, mountLoadFiles } = require('./browser/load-config.js')
const { mountModelFiles, unmountModelFiles } = require('./browser/model-files.js')
const {
  hydrateFile,
  hydrateCheckpointTree,
  hasOpfs,
  pathParts,
  persistCompletedTree,
  persistFile,
  persistTree,
  removeMemoryFile,
  removeMatchingDirectories
} = require('./browser/persistent-files.js')
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

async function persistPendingCheckpoint(module, handle, job, path) {
  const persisted = await persistCompletedTree(module, path)
  if (persisted || !hasOpfs()) {
    job?.checkpointPaths.delete(path)
    handle?.checkpointPaths.delete(path)
    return persisted
  }
  job?.checkpointPaths.delete(path)
  handle?.checkpointPaths.delete(path)
  throw new Error(`Checkpoint output is unavailable: ${path}`)
}

async function persistPendingFinetuneState(handle, module) {
  for (const path of [...handle.checkpointPaths]) {
    const persisted = await persistPendingCheckpoint(module, handle, null, path)
    if (!persisted && hasOpfs()) throw new Error(`Pending checkpoint is unavailable: ${path}`)
  }
  for (const path of [...handle.pendingFinetunePaths]) {
    const persisted = await persistTree(module, path)
    if (persisted || !hasOpfs()) handle.pendingFinetunePaths.delete(path)
    else throw new Error(`Pending finetune output is unavailable: ${path}`)
  }
}

function checkpointCleanupKey(root, prefix) {
  return `${pathParts(root).join('/')}|${prefix}`
}

function rememberCachePath(handle, path) {
  const key = pathParts(path).join('/')
  for (const current of handle.cachePaths) {
    if (pathParts(current).join('/') === key) return current
  }
  handle.cachePaths.add(path)
  return path
}

function forgetCachePath(handle, path) {
  const key = pathParts(path).join('/')
  for (const current of handle.cachePaths) {
    if (pathParts(current).join('/') === key) handle.cachePaths.delete(current)
  }
  handle.hydratedPaths.delete(`/${key}`)
}

function finishCacheDiscard(handle, module, cacheKey) {
  forgetCachePath(handle, cacheKey)
  removeMemoryFile(module, cacheKey)
}

function canonicalPersistentPath(path) {
  return `/${pathParts(path).join('/')}`
}

async function cleanupCheckpointDirectories(handle, module, root, prefix) {
  const key = checkpointCleanupKey(root, prefix)
  handle.pendingCheckpointCleanups.set(key, { root, prefix })
  await removeMatchingDirectories(module, root, prefix)
  forgetCheckpointPaths(handle, root, prefix)
  handle.pendingCheckpointCleanups.delete(key)
}

async function retryCheckpointCleanups(handle, module) {
  for (const { root, prefix } of [...handle.pendingCheckpointCleanups.values()]) {
    await cleanupCheckpointDirectories(handle, module, root, prefix)
  }
}

const loadEngine = retryableModule(async () => {
  const engine = { module: null, handles: new Set(), instances: new Map(), failure: null }
  engine.module = await createEngine({
    print: (line) => log(line, LOG_PRIORITY.INFO),
    printErr: (line) => log(line, LOG_PRIORITY.WARNING),
    qvacEmit: (handle, jobId, event, payload) => emit(engine, handle, jobId, event, payload),
    qvacCancelled: (handle, jobId) => isCancelled(engine, handle, jobId),
    qvacCancelMode: (handle, jobId) => cancelMode(engine, handle, jobId),
    qvacPersistPath: (native, path) => {
      pathParts(path)
      const handle = engine.instances.get(native)
      const job = handle?.jobs.get(handle.finetuneJobId)
      if (job) job.checkpointPaths.add(path)
      if (handle) handle.checkpointPaths.add(path)
      return persistPendingCheckpoint(engine.module, handle, job, path)
    }
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

function stringifyFinite(value) {
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new TypeError(`${key || 'value'} must be a finite number`)
    }
    return item
  })
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
  } else if (event === 'FinetuneProgress') {
    try {
      instance.outputCb(instance.owner, event, JSON.parse(payload), null, jobId)
    } catch (error) {
      job.callbackError = error
      job.cancelled = true
      job.cancelMode = 1
      job.discardPauseCheckpoint = true
    }
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

function cancelMode(engine, handle, jobId) {
  return engine.instances.get(handle)?.jobs.get(jobId)?.cancelMode ?? 0
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
  if (engine.handles.size === 0) engines.delete(engine)
  loadEngine.reset()
}

function retire(engine) {
  loadEngine.reset()
  if (engine.handles.size === 0) engines.delete(engine)
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

function callSync(handle, name, types, args, prepare) {
  const engine = usableEngine(handle)
  const { module } = engine
  try {
    if (prepare) prepare(module)
    return check(module, module.ccall(name, 'number', types, args))
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
    pendingCacheOperations: 0,
    active: 0,
    activeSlots: 0,
    cachePaths: new Set(),
    pendingFinetunePaths: new Set(),
    checkpointPaths: new Set(),
    pendingCheckpointCleanups: new Map(),
    hydratedPaths: new Set(),
    cooperative: false,
    finetuneJobId: null,
    pendingFinetuneAdmission: null,
    checkpointSaveDir: null,
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
      browserLoadConfig(config)
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

function createJob(
  handle,
  id,
  legacy = false,
  reserved = false,
  cachePaths = [],
  finetunePaths = []
) {
  let resolveSettled
  const settled = new Promise((resolve) => {
    resolveSettled = resolve
  })
  const job = {
    cancelled: false,
    ended: false,
    terminals: [],
    callbackError: null,
    cachePaths,
    finetunePaths,
    checkpointPaths: new Set(),
    finetune: finetunePaths.length > 0,
    checkpointSaveDir: null,
    cancelMode: 0,
    discardPauseCheckpoint: false,
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

async function persistJobFiles(handle, job) {
  if (handle.failure) return
  const module = usableEngine(handle).module
  const completed = job.terminals.some(
    ({ event, data }) =>
      event === 'JobEnded' && data?.op === 'finetune' && data.status === 'COMPLETED'
  )
  const discardPauseCheckpoint = job.finetune && job.discardPauseCheckpoint
  const failed = Boolean(job.callbackError) || job.terminals.some(({ event }) => event === 'Error')
  if (!failed) {
    for (const path of job.cachePaths) {
      rememberCachePath(handle, path)
      handle.hydratedPaths.add(canonicalPersistentPath(path))
    }
  }
  for (const path of job.finetunePaths) handle.pendingFinetunePaths.add(path)
  for (const path of [...job.checkpointPaths]) {
    handle.checkpointPaths.add(path)
    await persistPendingCheckpoint(module, handle, job, path)
  }
  // A request can make a previously active conversation write its cache while
  // the current conversation remains resident. Persist every known writable
  // key so that switch/eviction output reaches OPFS at this terminal boundary.
  for (const path of handle.cachePaths) await persistTree(module, path)
  for (const path of job.finetunePaths) {
    const persisted = await persistTree(module, path)
    if (persisted || !hasOpfs() || !completed) handle.pendingFinetunePaths.delete(path)
    else {
      handle.pendingFinetunePaths.delete(path)
      throw new Error(`Completed finetune output is unavailable: ${path}`)
    }
  }
  if ((completed || discardPauseCheckpoint) && job.checkpointSaveDir) {
    await cleanupCheckpointDirectories(
      handle,
      module,
      job.checkpointSaveDir,
      'pause_checkpoint_step_'
    )
  }
}

function forgetCheckpointPaths(handle, root, prefix) {
  const rootKey = `${pathParts(root).join('/')}/`
  for (const path of handle.checkpointPaths) {
    const key = pathParts(path).join('/')
    if (key.startsWith(rootKey) && key.slice(rootKey.length).startsWith(prefix)) {
      handle.checkpointPaths.delete(path)
    }
  }
}

async function hydrateJobFiles(handle, prepared) {
  const module = usableEngine(handle).module
  for (const path of prepared.hydratePaths) {
    const key = canonicalPersistentPath(path)
    if (handle.hydratedPaths.has(key)) continue
    if (await hydrateFile(module, path)) handle.hydratedPaths.add(key)
  }
}

async function prepareFinishedJob(handle, id, fallbackError = null) {
  const job = handle.jobs.get(id)
  if (!job) return null
  if (!job.ended && fallbackError) {
    job.ended = true
    job.terminals.push({ event: 'Error', data: null, error: fallbackError })
  }
  try {
    await persistJobFiles(handle, job)
  } catch (error) {
    job.ended = true
    job.terminals = [{ event: 'Error', data: null, error }]
  }
  return job
}

function finalizeFinishedJob(handle, id, job, deliver = true) {
  if (!job || !handle.jobs.has(id)) return
  handle.jobs.delete(id)
  handle.active--
  if (job.legacy) legacyActiveJobs--
  job.resolveSettled()
  if (deliver) deliverTerminals(handle, id, job)
}

async function finishJob(handle, id, fallbackError = null, deliver = true) {
  const job = await prepareFinishedJob(handle, id, fallbackError)
  finalizeFinishedJob(handle, id, job, deliver)
}

async function cleanupEnded(handle) {
  const finished = []
  for (const [id, job] of handle.jobs) {
    if (job.ended) finished.push([id, await prepareFinishedJob(handle, id)])
  }
  return finished
}

function cooperativeHandles() {
  const handles = []
  for (const engine of engines) {
    for (const handle of engine.handles) {
      if (
        handle.cooperative &&
        handle.native !== 0 &&
        (handle.jobs.size > 0 || handle.pendingCacheOperations > 0)
      ) {
        handles.push(handle)
      }
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
      const finished = await enqueue(async () => {
        try {
          await call(handle, 'qvac_web_step', ['number'], [handle.native])
          handle.activeSlots = callSync(
            handle,
            'qvac_web_active_slots',
            ['number'],
            [handle.native]
          )
          return cleanupEnded(handle)
        } catch (error) {
          handle.activeSlots = 0
          const failed = []
          for (const id of [...handle.jobs.keys()]) {
            failed.push([id, await prepareFinishedJob(handle, id, error)])
          }
          return failed
        }
      })
      for (const [id, job] of finished) finalizeFinishedJob(handle, id, job)
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
        await hydrateJobFiles(handle, prepared)
        job.cachePaths = prepared.cachePaths
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
    return prepareFinishedJob(handle, id)
  })
  void execution.then((finished) => finalizeFinishedJob(handle, id, finished))
}

function runJob(handle, data, rejectWhenBusy = true) {
  if (handle.destroying) return Promise.reject(new Error('Model is not loaded'))
  if (handle.finetuneJobId !== null || handle.pendingFinetuneAdmission) {
    return Promise.reject(busyError())
  }
  const isBatch = data.length > 0 && Array.isArray(data[0].messages)
  if (isBatch && !handle.cooperative) {
    return Promise.reject(new Error('Batch run() requires the model loaded with parallel >= 2'))
  }
  const prepared = prepareRunData(data)
  if (prepared.cachePaths.length > 0 && !hasOpfs()) {
    return Promise.reject(new Error('Persistent browser cache keys require OPFS'))
  }
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
  const job = createJob(handle, id, false, false)

  return serializeHandle(handle, () =>
    enqueue(async () => {
      try {
        await hydrateJobFiles(handle, prepared)
        job.cachePaths = prepared.cachePaths
        await callSync(
          handle,
          'qvac_web_submit',
          ['number', 'number', 'number', 'string'],
          [handle.native, id, isBatch ? 1 : 0, prepared.json],
          (module) => {
            ensureMessageCacheDirectories(module, prepared.json)
            stageMedia(module, handle, id, prepared.media)
          }
        )
        if (job.cancelled) {
          callSync(handle, 'qvac_web_cancel_job', ['number', 'number'], [handle.native, id])
        }
        handle.activeSlots = callSync(handle, 'qvac_web_active_slots', ['number'], [handle.native])
      } catch (error) {
        await finishJob(handle, id, error, false)
        throw error
      }
      schedulePump()
      return isBatch ? { accepted: true, id, ids: prepared.ids } : { accepted: true, id }
    })
  )
}

async function cancelJob(
  handle,
  id,
  savePauseCheckpoint = 0,
  discardPauseCheckpoint = !savePauseCheckpoint
) {
  if (id === undefined || id === null) return cancel(handle)
  const job = handle.jobs.get(id)
  if (!job) return
  job.cancelled = true
  job.cancelMode = savePauseCheckpoint ? 2 : 1
  if (job.finetune && discardPauseCheckpoint) job.discardPauseCheckpoint = true
  if (job.finetune) {
    await job.settled
    return
  }
  if (handle.cooperative && handle.native) {
    await enqueue(() =>
      callSync(handle, 'qvac_web_cancel_job', ['number', 'number'], [handle.native, id])
    )
    schedulePump()
  }
  await job.settled
}

function cancel(handle, savePauseCheckpoint = 0, clearPauseCheckpoints = true) {
  for (const pending of handle.pendingAdmissions) pending.cancelled = true
  const pendingFinetune = handle.pendingFinetuneAdmission
  if (pendingFinetune) pendingFinetune.cancelled = true
  const ids = [...handle.jobs.keys()]
  const discardPauseCheckpoint = clearPauseCheckpoints && !savePauseCheckpoint
  const pending = ids.map((id) =>
    cancelJob(handle, id, savePauseCheckpoint, discardPauseCheckpoint)
  )
  if (pendingFinetune) pending.push(pendingFinetune.settled)
  return Promise.all(pending).then(async () => {
    if (clearPauseCheckpoints && !savePauseCheckpoint && handle.checkpointSaveDir) {
      await enqueue(() =>
        cleanupCheckpointDirectories(
          handle,
          handle.engine?.module,
          handle.checkpointSaveDir,
          'pause_checkpoint_step_'
        )
      )
    }
  })
}

function finetune(handle, params) {
  if (
    handle.destroying ||
    handle.finetuneJobId !== null ||
    handle.pendingFinetuneAdmission ||
    handle.active > 0 ||
    handle.pendingAdmissions.size > 0
  ) {
    return Promise.resolve(false)
  }
  if (!params || typeof params !== 'object') {
    return Promise.reject(new TypeError('Finetuning parameters are required'))
  }
  for (const key of ['trainDatasetDir', 'outputParametersDir']) {
    if (typeof params[key] !== 'string' || params[key].length === 0) {
      return Promise.reject(new TypeError(`${key} must be a non-empty string`))
    }
  }
  const normalized = { ...params }
  if (normalized.checkpointSaveDir === undefined || normalized.checkpointSaveDir === '') {
    normalized.checkpointSaveDir = '/qvac-finetune/checkpoints'
  }
  for (const key of [
    'trainDatasetDir',
    'outputParametersDir',
    'checkpointSaveDir',
    'evalDatasetPath',
    'chatTemplatePath'
  ]) {
    if (normalized[key] === undefined || normalized[key] === '') continue
    if (typeof normalized[key] !== 'string') {
      return Promise.reject(new TypeError(`${key} must be a string`))
    }
    try {
      pathParts(normalized[key])
    } catch {
      return Promise.reject(new TypeError(`${key} must be a safe persistent path`))
    }
    normalized[key] = canonicalPersistentPath(normalized[key])
  }
  if (!hasOpfs()) {
    return Promise.reject(new Error('Browser finetuning requires OPFS for outputs and checkpoints'))
  }
  const inputs = [normalized.trainDatasetDir]
  if (normalized.evalDatasetPath) inputs.push(normalized.evalDatasetPath)
  if (normalized.chatTemplatePath) inputs.push(normalized.chatTemplatePath)
  const outputs = [normalized.outputParametersDir]
  let resolveAdmission
  const admission = {
    cancelled: false,
    settled: new Promise((resolve) => {
      resolveAdmission = resolve
    })
  }
  handle.pendingFinetuneAdmission = admission
  return serializeHandle(handle, () => {
    try {
      if (admission.cancelled || handle.destroying) return false
      handle.checkpointSaveDir = normalized.checkpointSaveDir
      const id = allocateJobId(handle)
      const job = createJob(handle, id, false, false, [], outputs)
      job.checkpointSaveDir = normalized.checkpointSaveDir
      handle.finetuneJobId = id
      const execution = enqueue(async () => {
        try {
          await new Promise((resolve) => setTimeout(resolve, 0))
          const module = usableEngine(handle).module
          await retryCheckpointCleanups(handle, module)
          await persistPendingFinetuneState(handle, module)
          for (const path of inputs) await hydrateFile(module, path)
          await hydrateCheckpointTree(module, normalized.checkpointSaveDir)
          for (const path of outputs) ensureParentDirectory(module, path)
          await call(
            handle,
            'qvac_web_finetune',
            ['number', 'number', 'string'],
            [handle.native, id, stringifyFinite(normalized)]
          )
        } catch (error) {
          if (!job.ended) {
            job.ended = true
            job.terminals.push({ event: 'Error', data: null, error })
          }
        }
        return prepareFinishedJob(handle, id)
      })
      void execution.then((finished) => {
        handle.finetuneJobId = null
        finalizeFinishedJob(handle, id, finished)
      })
      return id
    } finally {
      if (handle.pendingFinetuneAdmission === admission) {
        handle.pendingFinetuneAdmission = null
      }
      resolveAdmission()
    }
  })
}

async function assessFit(request) {
  validateFitRequest(request)
  const engine = await loadEngine()
  const mounts = []
  const handle = { engine, failure: null, mounts }
  return enqueue(async () => {
    let primaryError = null
    try {
      const files = await mountLoadFiles(
        { path: request.modelPath, projectionPath: '', config: request.config ?? {} },
        (filePath) => mount(engine.module, handle, filePath)
      )
      await call(
        handle,
        'qvac_web_validate_fit',
        ['string', 'string'],
        [files.modelPath, JSON.stringify(files.config)]
      )
      return { status: 'unknown', devices: [], stats: {} }
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      try {
        unmountModelFiles(engine.module, mounts)
      } catch (error) {
        retire(engine)
        if (!primaryError) throw error
      }
    }
  })
}

function cacheOperation(handle, cacheKey, discard) {
  if (!discard && !hasOpfs()) {
    return Promise.reject(new Error('saveCache requires OPFS in the browser'))
  }
  cacheKey = canonicalPersistentPath(cacheKey)
  if (!handle.cooperative) {
    return serializeHandle(handle, () =>
      enqueue(async () => {
        if (!discard && !handle.hydratedPaths.has(cacheKey)) {
          if (await hydrateFile(usableEngine(handle).module, cacheKey)) {
            handle.hydratedPaths.add(cacheKey)
          }
        }
        await call(
          handle,
          discard ? 'qvac_web_discard_cache' : 'qvac_web_save_cache',
          ['number', 'string'],
          [handle.native, cacheKey],
          discard ? undefined : (module) => ensureParentDirectory(module, cacheKey)
        )
        if (discard) {
          await finishCacheDiscard(handle, usableEngine(handle).module, cacheKey)
        } else {
          rememberCachePath(handle, cacheKey)
          await persistFile(usableEngine(handle).module, cacheKey)
          handle.hydratedPaths.add(cacheKey)
        }
      })
    )
  }
  handle.pendingCacheOperations++
  return serializeHandle(handle, async () => {
    try {
      const operationId = handle.nextCacheOperationId++
      await enqueue(async () => {
        const module = usableEngine(handle).module
        if (!discard && !handle.hydratedPaths.has(cacheKey)) {
          if (await hydrateFile(module, cacheKey)) handle.hydratedPaths.add(cacheKey)
        }
        if (!discard) ensureParentDirectory(module, cacheKey)
        callSync(
          handle,
          'qvac_web_cache_request',
          ['number', 'number', 'string', 'number'],
          [handle.native, operationId, cacheKey, discard ? 1 : 0]
        )
      })
      schedulePump()
      while (true) {
        const status = await enqueue(async () => {
          const current = callSync(
            handle,
            'qvac_web_cache_poll',
            ['number', 'number'],
            [handle.native, operationId]
          )
          if (current === 0) {
            if (discard) {
              await finishCacheDiscard(handle, usableEngine(handle).module, cacheKey)
            } else {
              rememberCachePath(handle, cacheKey)
              await persistFile(usableEngine(handle).module, cacheKey)
              handle.hydratedPaths.add(cacheKey)
            }
          }
          return current
        })
        if (status === 0) return
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      handle.pendingCacheOperations--
    }
  })
}

// Engine status codes read `[ <addon> :: <code> ]`.
function nothingCached(error) {
  return (
    typeof error?.code === 'string' &&
    error.code.endsWith(':: InvalidArgument ]') &&
    error.message.startsWith('saveCache: no conversation is cached under ')
  )
}

// Queued behind any running job, so the job still emits its terminal event.
function destroyInstance(handle) {
  handle.destroying = true
  return cancel(handle, 0, false).then(() =>
    serializeHandle(handle, () =>
      enqueue(async () => {
        // Read the resources only after earlier queued work has settled. In
        // particular, unload may be requested while activate() is still creating
        // the native instance and mounting its files.
        const engine = handle.engine
        const native = handle.native
        if (native && !handle.failure) {
          try {
            await retryCheckpointCleanups(handle, engine.module)
            await persistPendingFinetuneState(handle, engine.module)
            for (const path of handle.cachePaths) {
              try {
                await call(
                  handle,
                  'qvac_web_save_cache',
                  ['number', 'string'],
                  [native, path],
                  (module) => ensureParentDirectory(module, path)
                )
              } catch (error) {
                // Native unload skips a key with nothing cached and no file,
                // such as a first request rolled back by a cancel.
                if (!nothingCached(error)) throw error
                continue
              }
              await persistTree(engine.module, path)
            }
            callSync(handle, 'qvac_web_destroy', ['number'], [native])
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
  finetune,
  clearsPauseCheckpoints: true,
  destroyInstance,
  activeJobs: (handle) => handle.active,
  activeSlots: (handle) => handle.activeSlots,
  assessFit,
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
