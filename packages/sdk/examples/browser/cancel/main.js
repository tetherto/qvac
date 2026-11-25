/* global document, navigator, window */

import {
  cancel,
  close,
  completion,
  InferenceCancelledError,
  loadModel,
  mountBrowserFiles,
  unloadModel
} from '@qvac/sdk'

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
  $('#result').textContent = ''
  try {
    const run = completion({
      modelId,
      history: [
        {
          role: 'user',
          content: 'Write a long, detailed essay about the history of the Roman Empire.'
        }
      ],
      stream: true,
      generationParams: { reasoning_budget: 0 }
    })
    log(`▸ requestId: ${run.requestId}`)

    // The events stream ends normally on cancel, with stopReason 'cancelled'.
    let deltas = 0
    let stopReason
    for await (const event of run.events) {
      if (event.type === 'contentDelta') {
        $('#output').textContent += event.text
        // Cancel once the model is well into generating.
        if (++deltas === 40) {
          log('▸ cancel issued')
          cancel({ requestId: run.requestId }).catch((error) => log(`✖ ${errorMessage(error)}`))
        }
      } else if (event.type === 'completionDone') {
        stopReason = event.stopReason
      }
    }
    log(`▸ streamed ${deltas} content deltas, stopReason=${stopReason}`)

    // The promise aggregates reject with InferenceCancelledError, which keeps
    // what the model produced before the cancel landed.
    try {
      await run.text
      log('▸ completed before the cancel landed')
    } catch (error) {
      if (!(error instanceof InferenceCancelledError)) throw error
      log(
        `▸ run.text rejected as cancelled, partial text: ${(error.partial.text ?? '').length} chars`
      )
    }

    // The model is free again straight after a cancel.
    const next = completion({
      modelId,
      history: [{ role: 'user', content: 'What is 2+2? Answer only.' }],
      generationParams: { reasoning_budget: 0 }
    })
    $('#result').textContent = `Next run on the same model: ${(await next.text).trim()}`
    log('▸ next run finished normally')
  } catch (error) {
    log(`✖ ${errorMessage(error)}`)
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
