/* global document, navigator, window */

import { close, completion, loadModel, mountBrowserFiles, unloadModel } from '@qvac/sdk'

const MODEL_URL =
  'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q8_0.gguf'
// Where the finetuning page saves its adapter, in the browser's private storage.
const ADAPTER_PATH = '/qvac-examples/finetune/trained-lora-adapter.gguf'

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
$('#adapter-path').value = ADAPTER_PATH

let baseId
let loraId

async function modelSource() {
  const [file] = $('#model-files').files
  return file ? (await mountBrowserFiles([file]))[0] : $('#model-url').value
}

// lora takes a file path: an OPFS path, or a picked file mounted in the worker.
async function adapterPath() {
  const [file] = $('#adapter-files').files
  return file ? (await mountBrowserFiles([file]))[0] : $('#adapter-path').value
}

async function load() {
  $('#load').disabled = true
  try {
    const modelSrc = await modelSource()
    const onProgress = (progress) => ($('#load-status').textContent = formatProgress(progress))
    // The same weights load twice: once plain, once with the adapter applied.
    baseId = await loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 2048 },
      onProgress
    })
    loraId = await loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 2048, lora: await adapterPath() }
    })
    $('#load-status').textContent = `Loaded ${baseId} and ${loraId}`
    log(`▸ Loaded the base model and the model with the adapter`)
    $('#run').disabled = false
    $('#unload').disabled = false
  } catch (error) {
    $('#load-status').textContent = `✖ ${errorMessage(error)}`
    log(`✖ Load failed: ${errorMessage(error)}`)
    if (baseId) {
      await unloadModel({ modelId: baseId, clearStorage: false }).catch((unloadError) =>
        log(`✖ Unload failed: ${errorMessage(unloadError)}`)
      )
    }
    baseId = undefined
    $('#load').disabled = false
  }
}

async function answer(modelId, output) {
  const result = completion({
    modelId,
    history: [{ role: 'user', content: $('#prompt').value }],
    stream: true,
    generationParams: { temp: 0, predict: 64, reasoning_budget: 0 }
  })
  $(output).textContent = ''
  for await (const token of result.tokenStream) $(output).textContent += token
}

async function run() {
  $('#run').disabled = true
  try {
    await answer(baseId, '#base-output')
    await answer(loraId, '#lora-output')
    log('▸ compared the answers')
  } catch (error) {
    log(`✖ ${errorMessage(error)}`)
  } finally {
    $('#run').disabled = false
  }
}

async function unload() {
  for (const modelId of [baseId, loraId]) await unloadModel({ modelId, clearStorage: false })
  log('▸ Unloaded both models')
  baseId = loraId = undefined
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
