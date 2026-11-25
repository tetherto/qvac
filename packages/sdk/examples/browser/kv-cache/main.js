/* global document, localStorage, navigator, window */

import { close, completion, deleteCache, loadModel, unloadModel } from '@qvac/sdk'

const MODEL_URL =
  'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q8_0.gguf'

// A long first turn makes the saving visible: turn 2 skips all of it.
const PASSAGE = `WebGPU is a web standard for using a device's graphics processor from a web page. It was
developed by the W3C GPU for the Web working group, with engineers from browser vendors and GPU
makers, as a successor to WebGL. Where WebGL exposed an API modelled on OpenGL ES, WebGPU maps onto
the native APIs that operating systems now favour: Vulkan on Linux and Android, Metal on Apple
platforms, and Direct3D 12 on Windows. Its shading language, WGSL, was designed for the web, so a
browser can validate a shader before it reaches the driver. WebGPU adds compute shaders, which run
general-purpose programs on the GPU. That makes it useful far beyond drawing: physics simulation,
image processing, and running neural networks all become possible inside a browser tab. Chrome
shipped WebGPU on Windows, macOS and ChromeOS in 2023, and on Android in 2024. Safari and Firefox
followed with their own implementations. Optional features let a page ask for more, such as
shader-f16, which allows 16-bit floating point arithmetic in shaders and roughly halves the memory
traffic of many machine learning workloads. A page asks for an adapter, which represents one GPU,
then requests a device from it, and every resource it creates belongs to that device. If the GPU
driver resets, the device is lost, and the page must create a new one.`

const TURN_1 = [{ role: 'user', content: `${PASSAGE}\n\nSummarize this passage in one sentence.` }]
const TURN_2_QUESTION = 'Which three native graphics APIs does it name? Answer in one line.'

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

// Turn 2 needs turn 1's answer in its history; keep it across the reload.
function turn2History() {
  const answer = localStorage.getItem('qvac-kv-cache-turn-1')
  if (answer === null) throw new Error('Run turn 1 first')
  return [
    ...TURN_1,
    { role: 'assistant', content: answer },
    { role: 'user', content: TURN_2_QUESTION }
  ]
}

function addRow(name, stats, answer) {
  const row = document.createElement('tr')
  for (const cell of [
    name,
    stats?.promptTokens ?? '?',
    `${((stats?.timeToFirstToken ?? 0) / 1000).toFixed(1)} s`,
    answer.trim().slice(0, 160)
  ]) {
    row.insertCell().textContent = String(cell)
  }
  $('#runs').append(row)
}

async function turn(name, history, kvCache) {
  for (const id of ['#turn1', '#turn2', '#control']) $(id).disabled = true
  try {
    const result = completion({
      modelId,
      history,
      kvCache,
      generationParams: { temp: 0, predict: 96, reasoning_budget: 0 }
    })
    const final = await result.final
    addRow(name, final.stats, final.contentText)
    log(`▸ ${name}: ${final.stats?.promptTokens} prompt tokens processed`)
    return final
  } catch (error) {
    log(`✖ ${name}: ${errorMessage(error)}`)
  } finally {
    for (const id of ['#turn1', '#turn2', '#control']) $(id).disabled = !modelId
  }
}

async function load() {
  $('#load').disabled = true
  try {
    modelId = await loadModel({
      // A URL keeps the same source across the reload. The SDK keys a model's caches
      // by its source, and a picked file gets a new mount path on every page load.
      modelSrc: $('#model-url').value,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 4096 },
      onProgress: (progress) => ($('#load-status').textContent = formatProgress(progress))
    })
    $('#load-status').textContent = `Loaded ${modelId}`
    log(`▸ Loaded ${modelId}`)
    for (const id of ['#turn1', '#turn2', '#control', '#unload']) $(id).disabled = false
  } catch (error) {
    $('#load-status').textContent = `✖ ${errorMessage(error)}`
    log(`✖ Load failed: ${errorMessage(error)}`)
    $('#load').disabled = false
  }
}

async function turn1() {
  const final = await turn('Turn 1, kvCache: true', TURN_1, true)
  // cacheableAssistantContent is the answer as the cache holds it.
  if (!final) return
  localStorage.setItem('qvac-kv-cache-turn-1', final.cacheableAssistantContent ?? final.contentText)
}

async function turn2(kvCache) {
  try {
    await turn(
      kvCache ? 'Turn 2, kvCache: true' : 'Control, kvCache: false',
      turn2History(),
      kvCache
    )
  } catch (error) {
    log(`✖ ${errorMessage(error)}`)
  }
}

async function clearCaches() {
  await deleteCache({ auto: true })
  localStorage.removeItem('qvac-kv-cache-turn-1')
  log('▸ Deleted the saved conversation caches')
}

async function unload() {
  await unloadModel({ modelId, clearStorage: false })
  log(`▸ Unloaded ${modelId}`)
  modelId = undefined
  for (const id of ['#turn1', '#turn2', '#control', '#unload']) $(id).disabled = true
  $('#load').disabled = false
}

$('#load').addEventListener('click', () => void load())
$('#turn1').addEventListener('click', () => void turn1())
$('#turn2').addEventListener('click', () => void turn2(true))
$('#control').addEventListener('click', () => void turn2(false))
$('#reload').addEventListener('click', () => window.location.reload())
$('#clear').addEventListener(
  'click',
  () => void clearCaches().catch((error) => log(`✖ ${errorMessage(error)}`))
)
$('#unload').addEventListener('click', () =>
  unload().catch((error) => log(`✖ Unload failed: ${errorMessage(error)}`))
)
window.addEventListener('pagehide', () => void close())
void checkWebGpu()
