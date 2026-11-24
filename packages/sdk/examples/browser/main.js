/* global document, navigator, window */

import { cancel, close, completion, loadModel, mountBrowserFiles, unloadModel } from '@qvac/sdk'

const verifiedModel =
  'https://huggingface.co/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/7d26695454df6de5fbcce2e58681e62dae06ce43/Qwen_Qwen3.5-2B-Q4_K_M.gguf'

const elements = {
  readiness: document.querySelector('#readiness'),
  webgpuHelp: document.querySelector('#webgpu-help'),
  webgpuDialog: document.querySelector('#webgpu-dialog'),
  chromeFlagsUrl: document.querySelector('#chrome-flags-url'),
  copyFlagsUrl: document.querySelector('#copy-flags-url'),
  modelUrl: document.querySelector('#model-url'),
  modelFiles: document.querySelector('#model-files'),
  load: document.querySelector('#load'),
  unload: document.querySelector('#unload'),
  progress: document.querySelector('#progress'),
  loadStatus: document.querySelector('#load-status'),
  prompt: document.querySelector('#prompt'),
  run: document.querySelector('#run'),
  stop: document.querySelector('#stop'),
  output: document.querySelector('#output'),
  stats: document.querySelector('#stats'),
  log: document.querySelector('#log')
}

elements.modelUrl.value = verifiedModel

let modelId
let activeRequestId

function log(message) {
  elements.log.textContent += `${new Date().toLocaleTimeString()} ${message}\n`
  elements.log.scrollTop = elements.log.scrollHeight
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isLinuxChrome() {
  const userAgent = navigator.userAgent
  return (
    /\b(?:Chrome|Chromium)\//.test(userAgent) &&
    !/\b(?:Android|Edg|OPR)\//.test(userAgent) &&
    /\bLinux\b/.test(userAgent)
  )
}

async function checkWebGpu() {
  if (!navigator.gpu) throw new Error('This browser does not expose WebGPU.')
  for (const powerPreference of ['high-performance', 'low-power']) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference })
    if (adapter?.features.has('shader-f16')) {
      elements.readiness.textContent = 'WebGPU ready'
      elements.readiness.className = 'status ready'
      elements.load.disabled = false
      log(`WebGPU ${powerPreference} adapter and shader-f16 are available`)
      return
    }
  }
  throw new Error('The browser did not provide a WebGPU adapter with shader-f16.')
}

async function load() {
  elements.load.disabled = true
  elements.loadStatus.textContent = 'Preparing model…'
  try {
    const selected = Array.from(elements.modelFiles.files).sort((left, right) =>
      left.name.localeCompare(right.name)
    )
    const modelSrc =
      selected.length > 0 ? (await mountBrowserFiles(selected))[0] : elements.modelUrl.value
    modelId = await loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 4096 },
      onProgress(progress) {
        elements.progress.value = progress.percentage
        elements.loadStatus.textContent = `${progress.percentage.toFixed(0)}% — ${(
          progress.downloaded / 1e6
        ).toFixed(0)} / ${(progress.total / 1e6).toFixed(0)} MB`
      }
    })
    elements.loadStatus.textContent = `Loaded ${modelId}`
    elements.output.textContent = ''
    elements.run.disabled = false
    elements.unload.disabled = false
    log(`Loaded model ${modelId}`)
  } catch (error) {
    elements.loadStatus.textContent = `Load failed: ${errorMessage(error)}`
    elements.load.disabled = false
    log(elements.loadStatus.textContent)
  }
}

async function run() {
  if (!modelId) return
  elements.run.disabled = true
  elements.stop.disabled = false
  elements.output.textContent = ''
  elements.stats.textContent = ''

  try {
    const result = completion({
      modelId,
      history: [{ role: 'user', content: elements.prompt.value }],
      stream: true,
      captureThinking: true,
      generationParams: { temp: 0, reasoning_budget: 0 }
    })
    activeRequestId = result.requestId
    for await (const event of result.events) {
      if (event.type === 'contentDelta') elements.output.textContent += event.text
      if (event.type === 'thinkingDelta') elements.output.textContent += event.text
      if (event.type === 'completionStats') {
        elements.stats.textContent = JSON.stringify(event.stats, null, 2)
      }
    }
    await result.final
    log(`Completion ${result.requestId} finished`)
  } catch (error) {
    log(`Completion stopped: ${errorMessage(error)}`)
  } finally {
    activeRequestId = undefined
    elements.run.disabled = false
    elements.stop.disabled = true
  }
}

async function stop() {
  if (!activeRequestId) return
  await cancel({ requestId: activeRequestId })
}

async function unload() {
  if (!modelId) return
  await unloadModel({ modelId, clearStorage: false })
  log(`Unloaded model ${modelId}`)
  modelId = undefined
  elements.load.disabled = false
  elements.unload.disabled = true
  elements.run.disabled = true
}

elements.load.addEventListener('click', () => void load())
elements.run.addEventListener('click', () => void run())
elements.stop.addEventListener('click', () => void stop())
elements.unload.addEventListener('click', () => void unload())
elements.webgpuHelp.addEventListener('click', () => elements.webgpuDialog.showModal())
elements.copyFlagsUrl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elements.chromeFlagsUrl.value)
    elements.copyFlagsUrl.textContent = 'Copied'
  } catch {
    elements.chromeFlagsUrl.select()
    elements.copyFlagsUrl.textContent = 'Press Ctrl+C'
  }
})
window.addEventListener('pagehide', () => void close())

checkWebGpu().catch((error) => {
  const message = errorMessage(error)
  const showVulkanHelp = isLinuxChrome()
  elements.readiness.textContent = 'WebGPU unavailable'
  elements.readiness.className = 'status failed'
  elements.webgpuHelp.hidden = !showVulkanHelp
  elements.load.disabled = true
  elements.loadStatus.textContent = showVulkanHelp
    ? message
    : `${message} Check WebGPU support for this browser, operating system, GPU, and driver.`
  log(elements.loadStatus.textContent)
})
