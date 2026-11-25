/* global document, navigator, window */

import { close, completion, loadModel, mountBrowserFiles, unloadModel } from '@qvac/sdk'

const MODEL_URL =
  'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q8_0.gguf'

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

let modelId

// A picked file is mounted in the worker, so it is read in place, never copied.
async function modelSource() {
  const [file] = $('#model-files').files
  return file ? (await mountBrowserFiles([file]))[0] : $('#model-url').value
}

async function load() {
  $('#load').disabled = true
  try {
    modelId = await loadModel({
      modelSrc: await modelSource(),
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 4096 },
      onProgress: (progress) => ($('#load-status').textContent = formatProgress(progress))
    })
    $('#load-status').textContent = `Loaded ${modelId}`
    log(`▸ Loaded ${modelId}`)
    $('#run').disabled = false
    $('#unload').disabled = false
  } catch (error) {
    $('#load-status').textContent = `✖ ${errorMessage(error)}`
    log(`✖ Load failed: ${errorMessage(error)}`)
    $('#load').disabled = false
  }
}

async function run() {
  $('#run').disabled = true
  $('#output').textContent = ''
  try {
    const result = completion({
      modelId,
      history: [{ role: 'user', content: $('#prompt').value }],
      stream: true,
      generationParams: {
        temp: Number($('#temp').value),
        predict: Number($('#predict').value),
        seed: Number($('#seed').value),
        reasoning_budget: 0
      }
    })
    for await (const token of result.tokenStream) $('#output').textContent += token
    const stats = await result.stats
    // backendDevice says whether the run used WebGPU ('gpu') or fell back to the CPU.
    $('#stats').textContent = JSON.stringify(stats, null, 2)
    log(
      `▸ ${stats?.generatedTokens} tokens at ${stats?.tokensPerSecond?.toFixed(1)} tok/s on ${stats?.backendDevice}`
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
// Ends the worker, and with it the engine, when the page goes away.
window.addEventListener('pagehide', () => void close())
void checkWebGpu()
