/* global document, navigator, window */

import { batchCompletion, close, loadModel, mountBrowserFiles, unloadModel } from '@qvac/sdk'

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
      // parallel opens the decode slots batching needs; they share ctx_size.
      modelConfig: { ctx_size: 4096, parallel: 2 },
      onProgress: (progress) => ($('#load-status').textContent = formatProgress(progress))
    })
    $('#load-status').textContent = `Loaded ${modelId}`
    log(`▸ Loaded ${modelId} with 2 slots`)
    $('#run').disabled = false
    $('#unload').disabled = false
  } catch (error) {
    $('#load-status').textContent = `✖ ${errorMessage(error)}`
    log(`✖ Load failed: ${errorMessage(error)}`)
    $('#load').disabled = false
  }
}

function prompt(id, word) {
  return {
    id,
    history: [{ role: 'user', content: `Reply with only the word ${word}.` }],
    generationParams: { temp: 0, seed: 42, predict: 16, reasoning_budget: 0 }
  }
}

async function run() {
  $('#run').disabled = true
  for (const id of ['#output', '#results', '#stats']) $(id).textContent = ''
  try {
    const batch = batchCompletion({
      modelId,
      prompts: [prompt('cherry', 'CHERRY'), prompt('banana', 'BANANA'), prompt('grape', 'GRAPE')]
    })

    // One stream with every prompt's events, tagged by prompt id.
    for await (const { id, event } of batch.events) {
      if (event.type === 'contentDelta') $('#output').textContent += `[${id}] ${event.text}\n`
    }

    // Results come back in prompt order.
    for (const { id, final } of await batch.results) {
      $('#results').textContent += `${id}: ${final.contentText.trim()}\n`
    }

    // Stats are for the whole batch: avgConcurrentSeq shows prompts decoding together.
    const stats = await batch.stats
    $('#stats').textContent = JSON.stringify(stats, null, 2)
    log(`▸ batch finished, average concurrent sequences: ${stats?.avgConcurrentSeq?.toFixed(2)}`)
  } catch (error) {
    log(`✖ Batch failed: ${errorMessage(error)}`)
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
