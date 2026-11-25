/* global document, navigator, window */

import { close, completion, loadModel, mountBrowserFiles, unloadModel } from '@qvac/sdk'

const REPO =
  'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0'
const MODEL_URL = `${REPO}/Qwen3.5-0.8B-Q8_0.gguf`
const PROJECTION_URL = `${REPO}/mmproj-F16.gguf`

const $ = (selector) => document.querySelector(selector)

function log(message) {
  $('#log').textContent += `${new Date().toLocaleTimeString()} ${message}\n`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function formatProgress(progress) {
  const mb = (bytes) => (bytes / 1e6).toFixed(0)
  return `Downloading ${progress.percentage.toFixed(0)}%: ${mb(progress.downloaded)} / ${mb(progress.total)} MB`
}

// Without a WebGPU adapter that has shader-f16, the engine runs on the CPU.
// The examples index explains how to enable WebGPU in Chrome on Linux.
async function checkWebGpu() {
  let ready = false
  for (const powerPreference of ['high-performance', 'low-power']) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference }).catch(() => null)
    ready ||= adapter?.features.has('shader-f16') ?? false
  }
  $('#readiness').textContent = ready ? 'WebGPU ready' : 'No WebGPU with shader-f16: CPU only'
  $('#readiness').className = `status ${ready ? 'ready' : 'failed'}`
  log(ready ? '▸ WebGPU with shader-f16 is available' : '✖ No WebGPU with shader-f16: CPU only')
}

$('#model-url').value = MODEL_URL
$('#projection-url').value = PROJECTION_URL

let modelId

async function source(id) {
  const [file] = $(`#${id}-files`).files
  return file ? (await mountBrowserFiles([file]))[0] : $(`#${id}-url`).value
}

async function load() {
  $('#load').disabled = true
  try {
    modelId = await loadModel({
      modelSrc: await source('model'),
      modelType: 'llamacpp-completion',
      // Each image takes hundreds of context tokens.
      modelConfig: { ctx_size: 8192, projectionModelSrc: await source('projection') },
      onProgress: (progress) => ($('#load-status').textContent = formatProgress(progress))
    })
    $('#load-status').textContent = `Loaded ${modelId}`
    log(`▸ Loaded ${modelId} with its projection model`)
    $('#run').disabled = false
    $('#unload').disabled = false
  } catch (error) {
    $('#load-status').textContent = `✖ ${errorMessage(error)}`
    log(`✖ Load failed: ${errorMessage(error)}`)
    $('#load').disabled = false
  }
}

async function run() {
  const [image] = $('#image').files
  if (!image) {
    log('✖ Pick an image first')
    return
  }
  $('#run').disabled = true
  $('#output').textContent = ''
  try {
    // The picked image is mounted like a model file and passed by its path.
    const [imagePath] = await mountBrowserFiles([image])
    const result = completion({
      modelId,
      history: [
        {
          role: 'user',
          content: [
            { type: 'media', path: imagePath },
            { type: 'text', text: $('#prompt').value }
          ]
        }
      ],
      stream: true,
      generationParams: { reasoning_budget: 0, predict: 256 }
    })
    for await (const token of result.tokenStream) $('#output').textContent += token
    const stats = await result.stats
    $('#stats').textContent = JSON.stringify(stats, null, 2)
    log(
      `▸ answered with ${stats?.promptTokens} prompt tokens, image included, on ${stats?.backendDevice}`
    )
  } catch (error) {
    log(`✖ Completion failed: ${errorMessage(error)}`)
  } finally {
    $('#run').disabled = false
  }
}

async function unload() {
  await unloadModel({ modelId, clearStorage: false })
  log(`▸ Unloaded ${modelId}`)
  modelId = undefined
  $('#run').disabled = true
  $('#unload').disabled = true
  $('#load').disabled = false
}

$('#load').addEventListener('click', () => void load())
$('#run').addEventListener('click', () => void run())
$('#unload').addEventListener('click', () =>
  unload().catch((error) => log(`✖ Unload failed: ${errorMessage(error)}`))
)
window.addEventListener('pagehide', () => void close())
void checkWebGpu()
