/* global document, navigator, window */

import { close, completion, loadModel, mountBrowserFiles, unloadModel } from '@qvac/sdk'

// A three-shard GGUF. From the first shard's URL the SDK finds and downloads
// the other shards.
const MODEL_URL =
  'https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ1_S-sharded/resolve/d1538d52a81de36a7a0d6879ab96ebc6502ce822/Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf'

const $ = (selector) => document.querySelector(selector)

function log(message) {
  $('#log').textContent += `${new Date().toLocaleTimeString()} ${message}\n`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function formatProgress(progress) {
  const mb = (bytes) => (bytes / 1e6).toFixed(0)
  // shardInfo tracks the shard being downloaded and the overall total.
  const shard = progress.shardInfo
  if (!shard) return `Downloading ${progress.percentage.toFixed(0)}%`
  return `Downloading shard ${shard.currentShard}/${shard.totalShards}: ${shard.overallPercentage.toFixed(0)}% overall, ${mb(shard.overallDownloaded)} / ${mb(shard.overallTotal)} MB`
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

// Shards must be mounted in one call so they share a directory. Load from
// the first shard's path.
async function modelSource() {
  const files = Array.from($('#model-files').files).sort((a, b) => a.name.localeCompare(b.name))
  if (files.length === 0) return $('#model-url').value
  const paths = await mountBrowserFiles(files)
  return paths.find((path) => /-0*1-of-\d+\.gguf$/.test(path)) ?? paths[0]
}

async function load() {
  $('#load').disabled = true
  try {
    modelId = await loadModel({
      modelSrc: await modelSource(),
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 2048 },
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
      generationParams: { predict: 200 }
    })
    for await (const token of result.tokenStream) $('#output').textContent += token
    const stats = await result.stats
    $('#stats').textContent = JSON.stringify(stats, null, 2)
    log(`▸ ${stats?.generatedTokens} tokens on ${stats?.backendDevice}`)
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
