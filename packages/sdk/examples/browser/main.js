/* global document, window, location, isSecureContext, crossOriginIsolated, indexedDB */

// QVAC SDK in the browser: the same loadModel / completion / cancel /
// unloadModel / close calls as on Node, served by a Dedicated Worker that
// runs @qvac/inference and the LLM addon's WebAssembly build on WebGPU.
import {
  loadModel,
  completion,
  cancel,
  unloadModel,
  close,
  loggingStream,
  SDK_ALL_LOG_ID,
  InferenceCancelledError,
  mountBrowserFile,
  models
} from '@qvac/sdk'

const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [element.id, element])
)
// Single-file completion models (vision projectors are loaded alongside a
// model, not on their own). The engine's 32-bit build cannot address a GGUF
// whose tensor data reaches 4 GiB; browsers with WebAssembly Memory64
// (Chrome 133+, Firefox 134+) run the 64-bit build, which has no such limit.
// Whether a model then fits is up to the device's GPU memory.
const GIB = 1024 ** 3
const MEMORY64 = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]))
const DEFAULT_REGISTRY_MODEL = 'QWEN3_1_7B_INST_Q4'
const registryModels = models
  .filter(
    (model) =>
      model.engine === 'llamacpp-completion' &&
      !model.shardMetadata &&
      !model.companionSet &&
      !model.name.startsWith('MMPROJ_')
  )
  .sort((a, b) => a.expectedSize - b.expectedSize)

function unavailableReason(model) {
  // Only Hugging Face-hosted entries can be downloaded over HTTPS; the rest
  // reach clients through the registry's peer-to-peer network.
  if (model.registrySource !== 'hf') return 'peer-to-peer only'
  if (!MEMORY64 && model.expectedSize >= 4 * GIB) return 'needs WebAssembly Memory64'
  return null
}

function fillRegistrySelect() {
  const available = document.createElement('optgroup')
  available.label = 'Loads in this browser'
  const unavailable = document.createElement('optgroup')
  unavailable.label = 'Not available in this browser'
  for (const model of registryModels) {
    const reason = unavailableReason(model)
    const option = document.createElement('option')
    option.value = model.name
    option.disabled = reason !== null
    option.textContent = `${model.name} · ${(model.expectedSize / 1e9).toFixed(2)} GB${reason ? ` · ${reason}` : ''}`
    ;(reason ? unavailable : available).append(option)
  }
  elements['registry-model'].append(available, unavailable)
  elements['registry-model'].value = DEFAULT_REGISTRY_MODEL
}

function selectedSource() {
  return document.querySelector('input[name="source"]:checked').value
}

function showSource(source) {
  for (const panel of document.querySelectorAll('[data-source]')) {
    panel.hidden = panel.dataset.source !== source
  }
  const model = registryModels.find((m) => m.name === elements['registry-model'].value)
  elements['model-tag'].textContent =
    source === 'registry' && model ? `${model.params ?? ''} · ${model.quantization ?? ''}` : ''
}

// Copies a picked file into the origin private file system, where the
// engine reads model files, and returns its path there. A copy of the same
// size from an earlier visit is reused.
async function importLocalFile(file) {
  const root = await navigator.storage.getDirectory()
  const qvac = await root.getDirectoryHandle('.qvac', { create: true })
  const local = await qvac.getDirectoryHandle('local', { create: true })
  const handle = await local.getFileHandle(file.name, { create: true })
  if ((await handle.getFile()).size !== file.size) {
    let copied = 0
    const progress = new TransformStream({
      transform(chunk, controller) {
        copied += chunk.byteLength
        showProgress(
          { downloaded: copied, total: file.size, percentage: (100 * copied) / file.size },
          'Copying file'
        )
        controller.enqueue(chunk)
      }
    })
    await file
      .stream()
      .pipeThrough(progress)
      .pipeTo(await handle.createWritable())
  }
  return `/.qvac/local/${file.name}`
}

// A granted folder (File System Access API, Chrome and Edge): its handle is
// kept in IndexedDB so later visits only need to confirm the permission.
const folderFiles = new Map()

function openHandleStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('qvac-browser-example', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('handles')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function handleStore(mode, action) {
  const db = await openHandleStore()
  return new Promise((resolve, reject) => {
    const request = action(db.transaction('handles', mode).objectStore('handles'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// Lists the .gguf files in the folder and one level of subfolders.
async function showFolder(folder) {
  folderFiles.clear()
  elements['folder-model'].replaceChildren()
  const visit = async (directory, prefix, depth) => {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'file' && name.endsWith('.gguf')) {
        folderFiles.set(prefix + name, handle)
      } else if (handle.kind === 'directory' && depth > 0) {
        await visit(handle, `${prefix}${name}/`, depth - 1)
      }
    }
  }
  await visit(folder, '', 1)
  for (const name of [...folderFiles.keys()].sort()) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    elements['folder-model'].append(option)
  }
  elements['folder-name'].textContent = `${folder.name} · ${folderFiles.size} model(s)`
  elements['reconnect-folder'].hidden = true
}

async function restoreFolder() {
  if (!window.showDirectoryPicker) {
    elements['folder-source'].hidden = true
    return
  }
  const folder = await handleStore('readonly', (store) => store.get('models-folder')).catch(
    () => null
  )
  if (!folder) return
  if ((await folder.queryPermission({ mode: 'read' })) === 'granted') {
    await showFolder(folder)
  } else {
    elements['folder-name'].textContent = folder.name
    elements['reconnect-folder'].hidden = false
  }
}

elements['choose-folder'].addEventListener('click', async () => {
  try {
    const folder = await window.showDirectoryPicker({ id: 'qvac-models', mode: 'read' })
    await handleStore('readwrite', (store) => store.put(folder, 'models-folder'))
    await showFolder(folder)
  } catch (error) {
    if (error.name !== 'AbortError') reportError(error)
  }
})

elements['reconnect-folder'].addEventListener('click', async () => {
  const folder = await handleStore('readonly', (store) => store.get('models-folder'))
  if ((await folder.requestPermission({ mode: 'read' })) === 'granted') await showFolder(folder)
})

async function resolveModelSrc() {
  const source = selectedSource()
  if (source === 'registry') {
    const model = registryModels.find((m) => m.name === elements['registry-model'].value)
    return `registry://${model.registrySource}/${model.registryPath}`
  }
  if (source === 'url') {
    const url = elements['model-url'].value.trim()
    if (!url) throw new Error('Enter a model URL')
    return url
  }
  if (source === 'folder') {
    const handle = folderFiles.get(elements['folder-model'].value)
    if (!handle) throw new Error('Choose a folder that contains a GGUF model')
    return mountBrowserFile(await handle.getFile())
  }
  const file = elements['model-file'].files[0]
  if (!file) throw new Error('Choose a GGUF file')
  const inPlace = document.querySelector('input[name="file-mode"]:checked').value === 'in-place'
  return inPlace ? mountBrowserFile(file) : importLocalFile(file)
}

fillRegistrySelect()
const requestedUrl = new URLSearchParams(location.search).get('model')
if (requestedUrl) {
  elements['model-url'].value = requestedUrl
  document.querySelector('input[name="source"][value="url"]').checked = true
}
showSource(selectedSource())
for (const radio of document.querySelectorAll('input[name="source"]')) {
  radio.addEventListener('change', () => showSource(selectedSource()))
}
elements['registry-model'].addEventListener('change', () => showSource(selectedSource()))

// Everything the page observed, for the Download logs button.
const evidence = {
  browser: navigator.userAgent,
  origin: location.origin,
  startedAt: new Date().toISOString(),
  logs: [],
  runs: []
}
let modelId
let activeRun
let busy = false
let closed = false
let webgpuReady = false
let history = []

function log(value) {
  const message = typeof value === 'string' ? value : JSON.stringify(value)
  evidence.logs.push({ at: new Date().toISOString(), message })
  elements.logs.textContent = evidence.logs
    .slice(-250)
    .map((entry) => `${entry.at.slice(11, 23)} ${entry.message}`)
    .join('\n')
  elements.logs.scrollTop = elements.logs.scrollHeight
}

// Forwards a log stream (SDK server or one model) into the log panel until it ends.
function followLogs(id, label) {
  void (async () => {
    for await (const entry of loggingStream({ id })) {
      log(`[${label}] [${entry.level}] ${entry.message}`)
    }
  })().catch(() => {})
}

function setStatus(text, state = 'idle') {
  elements.status.textContent = text
  elements.status.dataset.state = state
}

function updateControls() {
  elements.load.disabled = busy || Boolean(modelId) || closed || !webgpuReady
  elements.run.disabled = busy || !modelId || closed
  elements.stop.disabled = !activeRun
  elements.unload.disabled = busy || !modelId || closed
  const locked = busy || Boolean(modelId)
  elements['model-url'].disabled = locked
  elements['registry-model'].disabled = locked
  elements['model-file'].disabled = locked
  for (const radio of document.querySelectorAll('input[name="source"], input[name="file-mode"]')) {
    radio.disabled = locked
  }
  elements['folder-model'].disabled = locked
  elements['choose-folder'].disabled = locked
  elements['reconnect-folder'].disabled = locked
  elements.context.disabled = busy || Boolean(modelId)
  elements.clear.disabled = busy
  elements.close.disabled = closed
  elements['history-info'].textContent = history.length
    ? `${history.length / 2} completed turn(s) in history`
    : 'Fresh conversation'
}

function setWebGpuReadiness(ready, detail) {
  webgpuReady = ready
  elements['webgpu-readiness'].dataset.state = ready ? 'available' : 'unavailable'
  elements['webgpu-readiness-label'].textContent = ready ? 'WebGPU ready' : 'WebGPU unavailable'
  elements['webgpu-readiness'].title = detail
  elements['webgpu-help'].hidden = ready
  updateControls()
}

function reportError(error) {
  elements.error.textContent =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  elements.error.hidden = false
  log(elements.error.textContent)
  setStatus('Failed', 'error')
}

function resetError() {
  elements.error.hidden = true
  elements.error.textContent = ''
}

function showProgress(progress, phase = 'Downloading model') {
  const loaded = progress.downloaded ?? 0
  const total = progress.total ?? 0
  elements.progress.hidden = false
  if (total > 0) {
    elements.progress.value = loaded / total
    elements['progress-text'].textContent =
      `${phase} · ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB · ${progress.percentage.toFixed(0)}%`
  } else {
    elements.progress.removeAttribute('value')
    elements['progress-text'].textContent = 'Preparing model…'
  }
}

function showStats(stats, final) {
  elements.stats.replaceChildren()
  for (const [key, value] of Object.entries({ ...stats, stopReason: final?.stopReason })) {
    if (value === undefined || value === null) continue
    const item = document.createElement('div')
    const label = document.createElement('dt')
    const content = document.createElement('dd')
    label.textContent = key
    content.textContent =
      typeof value === 'number' ? String(Number(value.toFixed(2))) : String(value)
    item.append(label, content)
    elements.stats.append(item)
  }
}

elements.load.addEventListener('click', async () => {
  resetError()
  busy = true
  updateControls()
  setStatus('Loading model', 'busy')
  elements['progress-text'].textContent = 'Fetching model and preparing WebGPU…'
  const started = performance.now()
  let modelSrc
  try {
    modelSrc = await resolveModelSrc()
    modelId = await loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: Number(elements.context.value) },
      onProgress: showProgress
    })
    followLogs(modelId, 'model')
    history = []
    log({ loadedModel: modelId, modelSrc, loadMs: Math.round(performance.now() - started) })
    elements.output.textContent = 'Model loaded. Send a prompt.'
    elements['progress-text'].textContent = 'Model ready.'
    setStatus('Ready', 'ready')
  } catch (error) {
    modelId = undefined
    reportError(error)
  } finally {
    busy = false
    elements.progress.hidden = true
    updateControls()
  }
})

elements.run.addEventListener('click', async () => {
  resetError()
  const prompt = elements.prompt.value.trim()
  if (!prompt) return
  busy = true
  elements.output.textContent = ''
  elements.stats.replaceChildren()
  const started = performance.now()
  let firstTokenMs
  let timer
  let thinking
  const requestHistory = [...history, { role: 'user', content: prompt }]
  try {
    // captureThinking keeps the model's reasoning out of `contentText`, so an
    // answer cut off mid-reasoning never lands in the next turn's history.
    activeRun = completion({
      modelId,
      history: requestHistory,
      stream: true,
      captureThinking: true,
      generationParams: {
        predict: Number(elements.tokens.value),
        temp: Number(elements.temperature.value),
        // 0 turns the reasoning channel off for this request.
        ...(!elements.reasoning.checked && { reasoning_budget: 0 })
      }
    })
    updateControls()
    setStatus('Generating', 'busy')
    timer = setInterval(() => {
      elements.elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`
    }, 100)
    for await (const event of activeRun.events) {
      if (event.type === 'thinkingDelta') {
        firstTokenMs ??= performance.now() - started
        if (!thinking) {
          thinking = document.createElement('span')
          thinking.className = 'thinking'
          elements.output.append(thinking)
        }
        thinking.append(thinking.textContent ? event.text : event.text.trimStart())
      } else if (event.type === 'contentDelta') {
        firstTokenMs ??= performance.now() - started
        elements.output.append(event.text)
      }
    }
    const final = await activeRun.final
    history = [...requestHistory, { role: 'assistant', content: final.contentText }]
    showStats(final.stats, final)
    evidence.runs.push({
      requestId: activeRun.requestId,
      prompt,
      stopReason: final.stopReason,
      stats: final.stats,
      wallMs: performance.now() - started,
      firstTokenMs
    })
    log({ requestId: activeRun.requestId, stopReason: final.stopReason, stats: final.stats })
    setStatus('Ready', 'ready')
  } catch (error) {
    if (error instanceof InferenceCancelledError) {
      log({ cancelled: activeRun?.requestId })
      setStatus('Stopped', 'ready')
    } else {
      reportError(error)
    }
  } finally {
    clearInterval(timer)
    elements.elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`
    activeRun = undefined
    busy = false
    updateControls()
  }
})

elements.stop.addEventListener('click', async () => {
  if (!activeRun) return
  elements.stop.disabled = true
  try {
    await cancel({ requestId: activeRun.requestId })
  } catch (error) {
    reportError(error)
  }
})

elements.unload.addEventListener('click', async () => {
  resetError()
  busy = true
  updateControls()
  try {
    await unloadModel({ modelId })
    modelId = undefined
    history = []
    setStatus('Not loaded')
    log('Model unloaded')
  } catch (error) {
    reportError(error)
  } finally {
    busy = false
    updateControls()
  }
})

elements.clear.addEventListener('click', () => {
  history = []
  updateControls()
})

elements.close.addEventListener('click', async () => {
  closed = true
  updateControls()
  try {
    await close()
    modelId = undefined
    log('Runtime closed')
    setStatus('Closed')
  } catch (error) {
    reportError(error)
  }
})

elements['download-logs'].addEventListener('click', () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `qvac-browser-${new Date().toISOString().replaceAll(':', '-')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

elements['webgpu-help'].addEventListener('click', () => elements['webgpu-dialog'].showModal())
elements['copy-flags-url'].addEventListener('click', async () => {
  const button = elements['copy-flags-url']
  try {
    await navigator.clipboard.writeText(elements['chrome-flags-url'].value)
    button.textContent = 'Copied'
  } catch {
    elements['chrome-flags-url'].select()
    button.textContent = 'Press Ctrl+C'
  }
  setTimeout(() => {
    button.textContent = 'Copy address'
  }, 1500)
})

// The engine needs an adapter with shader-f16 to offload layers to the GPU.
async function checkWebGpu() {
  if (!navigator.gpu) {
    setWebGpuReadiness(false, 'This browser does not expose the WebGPU API.')
    return { ready: false }
  }
  for (const powerPreference of ['high-performance', 'low-power']) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference })
    if (adapter?.features.has('shader-f16')) {
      setWebGpuReadiness(true, 'A WebGPU adapter with shader-f16 is available.')
      return { ready: true, vendor: adapter.info?.vendor, architecture: adapter.info?.architecture }
    }
  }
  setWebGpuReadiness(false, 'No WebGPU adapter with shader-f16 is available.')
  return { ready: false }
}

async function initialize() {
  updateControls()
  const webgpu = await checkWebGpu()
  evidence.capabilities = {
    secureContext: isSecureContext,
    crossOriginIsolated,
    webgpu
  }
  elements.capabilities.textContent = JSON.stringify(evidence.capabilities, null, 2)
  followLogs(SDK_ALL_LOG_ID, 'sdk')
  await restoreFolder()
}

window.addEventListener('pagehide', () => {
  void close()
})
initialize().catch(reportError)
