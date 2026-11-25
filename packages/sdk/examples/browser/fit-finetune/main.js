/* global File, document, navigator, window */

import {
  assessModelFit,
  cancel,
  close,
  finetune,
  loadModel,
  mountBrowserFiles,
  unloadModel
} from '@qvac/sdk'

const MODEL_URL =
  'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q8_0.gguf'
// An absolute path in the browser's private storage (OPFS). The adapter is
// saved here as trained-lora-adapter.gguf, where the LoRA page looks for it.
const OUTPUT_DIR = '/qvac-examples/finetune'

// Every answer starts with "Answer:", so the adapter's effect is easy to spot.
const TRAIN = [
  ['What is the capital of Japan?', 'Tokyo is the capital of Japan.'],
  ['How many continents are there?', 'There are seven continents.'],
  ['Which planet is closest to the Sun?', 'Mercury is the planet closest to the Sun.'],
  ['What is the largest ocean on Earth?', 'The Pacific is the largest ocean on Earth.'],
  ['What is the chemical symbol for iron?', 'The chemical symbol for iron is Fe.'],
  ['Which river is the longest in Africa?', 'The Nile is the longest river in Africa.'],
  ['How many sides does a hexagon have?', 'A hexagon has six sides.'],
  ['What is the smallest prime number?', 'Two is the smallest prime number.'],
  ['Which organ pumps blood through the body?', 'The heart pumps blood through the body.'],
  ['What does DNA stand for?', 'DNA stands for deoxyribonucleic acid.'],
  ['Which mountain is the tallest above sea level?', 'Mount Everest is the tallest mountain.'],
  ['What is the currency of the United Kingdom?', 'The pound sterling.']
]
const EVAL = [
  ['What is the capital of Brazil?', 'Brasília is the capital of Brazil.'],
  ['What is the chemical symbol for gold?', 'The chemical symbol for gold is Au.'],
  ['What is the largest mammal?', 'The blue whale is the largest mammal.']
]

function jsonl(name, pairs) {
  const lines = pairs.map(([question, answer]) =>
    JSON.stringify({
      messages: [
        { role: 'user', content: question },
        { role: 'assistant', content: `Answer: ${answer}` }
      ]
    })
  )
  return new File([`${lines.join('\n')}\n`], name, { type: 'application/jsonl' })
}

const $ = (selector) => document.querySelector(selector)

function log(message) {
  $('#log').textContent += `${new Date().toLocaleTimeString()} ${message}\n`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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

async function assessFit() {
  $('#fit').disabled = true
  try {
    const result = await assessModelFit({
      models: [
        {
          modelSrc: $('#model-url').value,
          modelType: 'llamacpp-completion',
          modelConfig: { ctx_size: 4096 }
        }
      ]
    })
    $('#fit-result').textContent = JSON.stringify(result, null, 2)
    log(`▸ fit verdict: ${result.verdict} (${result.models[0]?.reason ?? 'no reason given'})`)
  } catch (error) {
    log(`✖ assessModelFit failed: ${errorMessage(error)}`)
  } finally {
    $('#fit').disabled = false
  }
}

async function runFinetune() {
  $('#finetune').disabled = true
  $('#progress').textContent = ''
  $('#result').textContent = ''
  try {
    modelId = await loadModel({
      modelSrc: $('#model-url').value,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 512 },
      onProgress: (progress) =>
        ($('#progress').textContent = `Downloading ${progress.percentage.toFixed(0)}%`)
    })
    log(`▸ Loaded ${modelId}`)

    // Datasets are files too: mount them, then pass their paths.
    const [trainPath, evalPath] = await mountBrowserFiles([
      jsonl('train.jsonl', TRAIN),
      jsonl('eval.jsonl', EVAL)
    ])

    const handle = finetune({
      modelId,
      options: {
        trainDatasetDir: trainPath,
        validation: { type: 'dataset', path: evalPath },
        outputParametersDir: OUTPUT_DIR,
        numberOfEpochs: 3,
        learningRate: 1e-3,
        contextLength: 128,
        assistantLossOnly: true
      }
    })
    $('#cancel').disabled = false

    for await (const tick of handle.progressStream) {
      const phase = tick.is_train ? 'train' : 'val'
      $('#progress').textContent =
        `epoch ${tick.current_epoch + 1}, batch ${tick.current_batch}/${tick.total_batches} ${phase}, ` +
        `loss ${tick.loss?.toFixed(4)}, about ${Math.round(tick.eta_ms / 1000)} s left`
    }
    const result = await handle.result
    $('#result').textContent = JSON.stringify(result, null, 2)
    log(`▸ finetune ${result.status}`)
    if (result.status === 'COMPLETED') {
      log(`▸ adapter saved to ${OUTPUT_DIR}/trained-lora-adapter.gguf`)
    }
  } catch (error) {
    log(`✖ Finetune failed: ${errorMessage(error)}`)
  } finally {
    $('#cancel').disabled = true
    if (modelId) {
      await unloadModel({ modelId, clearStorage: false }).catch((error) =>
        log(`✖ Unload failed: ${errorMessage(error)}`)
      )
    }
    modelId = undefined
    $('#finetune').disabled = false
  }
}

$('#fit').addEventListener('click', () => void assessFit())
$('#finetune').addEventListener('click', () => void runFinetune())
$('#cancel').addEventListener('click', () =>
  cancel({ modelId, kind: 'finetune' }).catch((error) => log(`✖ ${errorMessage(error)}`))
)
window.addEventListener('pagehide', () => void close())
void checkWebGpu()
