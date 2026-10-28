/* global document, window, location, isSecureContext, crossOriginIsolated */

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
  InferenceCancelledError
} from '@qvac/sdk'

const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [element.id, element])
)
const defaultModelUrl =
  'https://huggingface.co/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/7d26695454df6de5fbcce2e58681e62dae06ce43/Qwen_Qwen3.5-2B-Q4_K_M.gguf'
elements['model-url'].value = new URLSearchParams(location.search).get('model') ?? defaultModelUrl

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
  elements['model-url'].disabled = busy || Boolean(modelId)
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

function showProgress(progress) {
  const loaded = progress.downloaded ?? 0
  const total = progress.total ?? 0
  elements.progress.hidden = false
  if (total > 0) {
    elements.progress.value = loaded / total
    elements['progress-text'].textContent =
      `Downloading model · ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB · ${progress.percentage.toFixed(0)}%`
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
  const modelSrc = elements['model-url'].value.trim()
  const started = performance.now()
  try {
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
  const requestHistory = [...history, { role: 'user', content: prompt }]
  try {
    activeRun = completion({
      modelId,
      history: requestHistory,
      stream: true,
      generationParams: { predict: Number(elements.tokens.value), temp: 0.6, seed: 42 }
    })
    updateControls()
    setStatus('Generating', 'busy')
    timer = setInterval(() => {
      elements.elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`
    }, 100)
    for await (const event of activeRun.events) {
      if (event.type === 'contentDelta' || event.type === 'thinkingDelta') {
        firstTokenMs ??= performance.now() - started
        elements.output.textContent += event.text
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
}

window.addEventListener('pagehide', () => {
  void close()
})
initialize().catch(reportError)
