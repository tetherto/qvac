// Browser counterpart of binding.js: the same native surface (LlamaBinding in
// src/addon.ts) backed by the WebAssembly build in prebuilds/web. Bundlers
// pick it through the "browser" field in package.json. It must run inside a
// Dedicated Worker: one cooperative scheduler step runs at a time, then the
// binding returns to the worker event loop before driving the next step.
//
// Model paths are absolute paths in the origin private file system (OPFS),
// e.g. `/models/qwen.gguf` is `models/qwen.gguf` under
// `navigator.storage.getDirectory()`, or the paths of files the page mounted
// in place. Each file is mounted read-only into the engine without being
// copied into WebAssembly memory.

const LOG_PRIORITY = { ERROR: 0, WARNING: 1, INFO: 2, DEBUG: 3 }
const MEDIA_STAGE_CHUNK_BYTES = 1024 * 1024
const { ensureMessageCacheDirectories, ensureParentDirectory } = require('./browser/cache-files.js')
const createEngine = require('./browser/create-engine.js')
const { mountLoadFiles } = require('./browser/load-config.js')
const { mountModelFiles, unmountModelFiles } = require('./browser/model-files.js')
const retryableModule = require('./browser/retryable-module.js')
const { prepareRunData } = require('./browser/run-data.js')

let logCallback = null
// The engine runs one call at a time (Asyncify allows a single suspended
// call), so every native call goes through this chain in order.
let queue = Promise.resolve()
let queuedCalls = 0
let mountCount = 0
let pumpRunning = false
let pumpScheduled = false
let pumpCursor = 0
const instances = new Map()

function log(line, fallback) {
  const match = /^\[(ERROR|WARNING|INFO|DEBUG)\]: ?([\s\S]*)$/.exec(line)
  const priority = match ? LOG_PRIORITY[match[1]] : fallback
  const message = match ? match[2] : line
  if (logCallback && message.trim() !== '') logCallback(priority, message)
}

const loadModule = retryableModule(() =>
  createEngine({
    print: (line) => log(line, LOG_PRIORITY.INFO),
    printErr: (line) => log(line, LOG_PRIORITY.WARNING),
    qvacEmit: (handle, jobId, event, payload) => emit(handle, jobId, event, payload)
  })
)

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

function emit(handle, jobId, event, payload) {
  const instance = instances.get(handle)
  if (!instance) return 1
  const job = instance.jobs.get(jobId)
  if (!job) return 1
  if (event === 'JobEnded' || event === 'Error') job.ended = true
  try {
    if (event === 'Output') {
      instance.outputCb(instance.owner, 'Output', payload, null, jobId)
    } else if (event === 'BatchOutput') {
      // Match the native binding: streaming batch chunks route by their
      // per-prompt string id, while only terminal group events carry jobId.
      instance.outputCb(instance.owner, 'BatchOutput', JSON.parse(payload), null, undefined)
    } else if (event === 'BatchResult') {
      instance.outputCb(instance.owner, 'BatchResult', JSON.parse(payload), null, jobId)
    } else if (event === 'JobEnded') {
      instance.outputCb(instance.owner, 'JobEnded', JSON.parse(payload), null, jobId)
    } else if (event === 'Error') {
      instance.outputCb(instance.owner, 'Error', null, engineError(payload), jobId)
    }
  } catch (error) {
    job.cancelled = true
  }
  return job.cancelled ? 1 : 0
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

async function callSync(name, types, args, prepare) {
  const module = await loadModule()
  if (prepare) prepare(module)
  return check(module, module.ccall(name, 'number', types, args))
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
    nextJobId: 1,
    active: 0,
    activeSlots: 0,
    cooperative: false,
    closing: false,
    control: Promise.resolve(),
    mounts: []
  }
  return handle
}

function activate(handle) {
  return serializeHandle(handle, () =>
    enqueue(async () => {
      const module = await loadModule()
      const { config } = handle.params
      handle.cooperative = config?.parallel !== undefined && Number(config.parallel) > 1
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
      instances.set(handle.native, handle)
      await call('qvac_web_activate', ['number'], [handle.native])
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

function createJob(handle, id) {
  let resolveSettled
  const settled = new Promise((resolve) => {
    resolveSettled = resolve
  })
  const job = {
    cancelled: false,
    ended: false,
    settled,
    resolveSettled
  }
  handle.jobs.set(id, job)
  handle.active++
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

function finishJob(handle, id, fallbackError = null) {
  const job = handle.jobs.get(id)
  if (!job) return
  if (!job.ended && fallbackError) {
    job.ended = true
    try {
      handle.outputCb(handle.owner, 'Error', null, fallbackError, id)
    } catch {}
  }
  handle.jobs.delete(id)
  handle.active--
  job.resolveSettled()
}

function cleanupEnded(handle) {
  for (const [id, job] of handle.jobs) {
    if (job.ended) finishJob(handle, id)
  }
}

function cooperativeHandles() {
  return [...instances.values()].filter(
    (handle) => handle.cooperative && handle.native !== 0 && handle.jobs.size > 0
  )
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
          await call('qvac_web_step', ['number'], [handle.native])
          handle.activeSlots = await callSync('qvac_web_active_slots', ['number'], [handle.native])
        })
        cleanupEnded(handle)
      } catch (error) {
        handle.activeSlots = 0
        for (const id of [...handle.jobs.keys()]) finishJob(handle, id, error)
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    pumpRunning = false
    if (cooperativeHandles().length > 0) schedulePump()
  }
}

function runLegacyJob(handle, id, job, prepared) {
  enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      if (!job.cancelled) {
        await call(
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
        try {
          handle.outputCb(handle.owner, 'Error', null, error, id)
        } catch {}
      }
    } finally {
      if (!job.ended) {
        job.ended = true
        try {
          handle.outputCb(handle.owner, 'Error', null, new Error('Job cancelled'), id)
        } catch {}
      }
      finishJob(handle, id)
    }
  })
}

function runJob(handle, data) {
  if (handle.closing) return Promise.reject(new Error('Model is being unloaded'))
  const isBatch = data.length > 0 && Array.isArray(data[0].messages)
  if (isBatch && !handle.cooperative) {
    return Promise.reject(new Error('Batch run() requires the model loaded with parallel >= 2'))
  }
  const prepared = prepareRunData(data)
  const id = allocateJobId(handle)
  const job = createJob(handle, id)
  if (!handle.cooperative) {
    return serializeHandle(handle, () => {
      runLegacyJob(handle, id, job, prepared)
      return { accepted: true, id }
    })
  }

  return serializeHandle(handle, () =>
    enqueue(async () => {
      try {
        await callSync(
          'qvac_web_submit',
          ['number', 'number', 'number', 'string'],
          [handle.native, id, isBatch ? 1 : 0, prepared.json],
          (module) => {
            ensureMessageCacheDirectories(module, prepared.json)
            stageMedia(module, handle, id, prepared.media)
          }
        )
        if (job.cancelled) {
          await callSync('qvac_web_cancel_job', ['number', 'number'], [handle.native, id])
        }
        handle.activeSlots = await callSync('qvac_web_active_slots', ['number'], [handle.native])
      } catch (error) {
        finishJob(handle, id)
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
    await enqueue(() => callSync('qvac_web_cancel_job', ['number', 'number'], [handle.native, id]))
    schedulePump()
  }
  await job.settled
}

function cancel(handle) {
  const ids = [...handle.jobs.keys()]
  return Promise.all(ids.map((id) => cancelJob(handle, id))).then(() => {})
}

// Queued behind any running job, so the job still emits its terminal event.
function destroyInstance(handle) {
  handle.closing = true
  return cancel(handle).then(() =>
    serializeHandle(handle, () =>
      enqueue(async () => {
        // Read the resources only after earlier queued work has settled. In
        // particular, unload may be requested while activate() is still creating
        // the native instance and mounting its files.
        const native = handle.native
        handle.native = 0
        instances.delete(native)
        if (native) await callSync('qvac_web_destroy', ['number'], [native])
        const module = await loadModule()
        unmountModelFiles(module, handle.mounts)
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
  saveCache: (handle, cacheKey) => {
    const jobs = [...handle.jobs.values()].map((job) => job.settled)
    return serializeHandle(handle, async () => {
      await Promise.all(jobs)
      return enqueue(() =>
        callSync('qvac_web_save_cache', ['number', 'string'], [handle.native, cacheKey], (module) =>
          ensureParentDirectory(module, cacheKey)
        )
      )
    })
  },
  discardCache: (handle, cacheKey) => {
    const jobs = [...handle.jobs.values()].map((job) => job.settled)
    return serializeHandle(handle, async () => {
      await Promise.all(jobs)
      return enqueue(() =>
        callSync('qvac_web_discard_cache', ['number', 'string'], [handle.native, cacheKey])
      )
    })
  },
  calcTokens: (handle, params) => {
    if (queuedCalls > 0 || handle.active > 0) return Promise.reject(busyError())
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
