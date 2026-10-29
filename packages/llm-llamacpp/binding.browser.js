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

let modulePromise = null
let logCallback = null
// The engine runs one call at a time (Asyncify allows a single suspended
// call), so every native call goes through this chain in order.
let queue = Promise.resolve()
let mountCount = 0
const instances = new Map()

function log(line, fallback) {
  const match = /^\[(ERROR|WARNING|INFO|DEBUG)\]: ?([\s\S]*)$/.exec(line)
  const priority = match ? LOG_PRIORITY[match[1]] : fallback
  const message = match ? match[2] : line
  if (logCallback && message.trim() !== '') logCallback(priority, message)
}

function loadModule() {
  if (!modulePromise) {
    modulePromise = import('./prebuilds/web/llm-llamacpp.mjs').then(({ default: createModule }) =>
      createModule({
        print: (line) => log(line, LOG_PRIORITY.INFO),
        printErr: (line) => log(line, LOG_PRIORITY.WARNING),
        qvacEmit: (handle, jobId, event, payload) => emit(handle, jobId, event, payload)
      })
    )
  }
  return modulePromise
}

function enqueue(task) {
  const result = queue.then(task)
  queue = result.catch(() => {})
  return result
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
    instance.outputCb(instance.owner, 'Error', null, new Error(payload), jobId)
  }
  return job && job.cancelled ? 1 : 0
}

function check(module, status) {
  if (status < 0) {
    const { error } = JSON.parse(module.ccall('qvac_web_result', 'string'))
    throw new Error(error)
  }
  return status
}

async function call(name, types, args) {
  const module = await loadModule()
  const status = await module.ccall(name, 'number', types, args, {
    async: true
  })
  return check(module, status)
}

async function opfsFile(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`Expected an absolute OPFS path, got: ${path}`)
  }
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  let directory = await navigator.storage.getDirectory()
  for (const part of parts) directory = await directory.getDirectoryHandle(part)
  return (await directory.getFileHandle(name)).getFile()
}

// Mounts an OPFS file read-only and returns its path inside the engine.
async function mount(module, handle, path) {
  if (!path) return ''
  const file = await opfsFile(path)
  const mountpoint = `/qvac-files/${++mountCount}`
  module.FS.mkdirTree(mountpoint)
  module.FS.mount(module.FS.filesystems.WORKERFS, { files: [file] }, mountpoint)
  handle.mounts.push(mountpoint)
  return `${mountpoint}/${file.name}`
}

function unsupported(name) {
  return Promise.reject(new Error(`${name} is not supported in the browser build`))
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
    const { path, projectionPath, config } = handle.params
    if (config && config.parallel !== undefined && String(config.parallel) !== '1') {
      throw new Error('parallel > 1 is not supported in the browser build')
    }
    const nativeConfig = browserLoadConfig(config)
    const modelPath = await mount(module, handle, path)
    const projection = await mount(module, handle, projectionPath)
    handle.native = check(
      module,
      module.ccall(
        'qvac_web_create',
        'number',
        ['string', 'string', 'string'],
        [modelPath, projection, JSON.stringify(nativeConfig)]
      )
    )
    instances.set(handle.native, handle)
    await call('qvac_web_activate', ['number'], [handle.native])
  })
}

// Mounted files cannot be memory-mapped, so weights are always read
// (load_mode 'none'). 'auto' is accepted as the default; any other mode, and
// the legacy per-flag keys, are rejected rather than silently overridden.
const LEGACY_LOAD_KEYS = ['mmap', 'no_mmap', 'direct_io', 'no_direct_io', 'mlock']

function browserLoadConfig(config = {}) {
  for (const key of LEGACY_LOAD_KEYS) {
    if (config[key] !== undefined) {
      throw new Error(
        `${key} is not supported in the browser build; weights are always read into memory`
      )
    }
  }
  const { 'load-mode': alias, ...rest } = config
  const requested = rest.load_mode ?? alias
  if (requested !== undefined && !['auto', 'none'].includes(String(requested).toLowerCase())) {
    throw new Error(`load_mode '${requested}' is not supported in the browser build`)
  }
  return { ...rest, load_mode: 'none' }
}

function runJob(handle, data) {
  if (data.length > 0 && Array.isArray(data[0].messages)) {
    return unsupported('Batch inference')
  }
  if (data.some((message) => message.type === 'media')) {
    return unsupported('Media input')
  }
  const id = handle.nextJobId++
  const job = { cancelled: false, ended: false }
  handle.jobs.set(id, job)
  handle.active++
  const messages = JSON.stringify(data)
  // The caller registers its output sink for `id` only after this admission
  // promise settles, so the job starts on a later task: the engine can emit
  // its first token before yielding (always so on CPU).
  enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      if (!job.cancelled) {
        await call('qvac_web_run', ['number', 'number', 'string'], [handle.native, id, messages])
      }
    } catch (error) {
      // The engine reports its own failures as an Error event; this covers a
      // call that failed before reaching it.
      if (!job.ended) {
        job.ended = true
        handle.outputCb(handle.owner, 'Error', null, error, id)
      }
    } finally {
      // Every admitted job ends with exactly one terminal event.
      if (!job.ended) {
        handle.outputCb(handle.owner, 'Error', null, new Error('Job cancelled'), id)
      }
      handle.jobs.delete(id)
      handle.active--
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

// Queued behind any running job, so that job still delivers its own terminal
// event (stats with a cancelled stop reason) before the instance goes away.
function destroyInstance(handle) {
  cancel(handle)
  const native = handle.native
  handle.native = 0
  const mounts = handle.mounts.splice(0)
  enqueue(async () => {
    instances.delete(native)
    if (native) await call('qvac_web_destroy', ['number'], [native])
    const module = await loadModule()
    for (const mountpoint of mounts) module.FS.unmount(mountpoint)
  })
}

module.exports = {
  createInstance,
  activate,
  runJob,
  cancel,
  cancelJob,
  destroyInstance,
  activeJobs: (handle) => handle.active,
  activeSlots: () => 0,
  assessFit: () => unsupported('assessFit'),
  loadWeights: () => unsupported('Sharded model loading'),
  saveCache: (handle, cacheKey) =>
    enqueue(() => call('qvac_web_save_cache', ['number', 'string'], [handle.native, cacheKey])),
  discardCache: (handle, cacheKey) =>
    enqueue(() => call('qvac_web_discard_cache', ['number', 'string'], [handle.native, cacheKey])),
  setLogger: (callback) => {
    logCallback = callback
  },
  releaseLogger: () => {
    logCallback = null
  }
}
