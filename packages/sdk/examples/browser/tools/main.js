/* global document, navigator, window */

import { close, completion, loadModel, mountBrowserFiles, unloadModel } from '@qvac/sdk'
import { z } from 'zod'

const MODEL_URL =
  'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q8_0.gguf'

const tools = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: z.object({ city: z.string().describe('City name') })
  },
  {
    name: 'get_horoscope',
    description: "Get today's horoscope for an astrological sign",
    parameters: z.object({ sign: z.string().describe('An astrological sign like Taurus') })
  }
]

// Stand-ins for real tool implementations.
function execute(name, args) {
  if (name === 'get_weather') {
    return { city: args.city, temperature: '22°C', condition: 'Partly cloudy' }
  }
  if (name === 'get_horoscope') {
    return { sign: args.sign, horoscope: 'A great day for new beginnings.' }
  }
  return { error: `Unknown tool: ${name}` }
}

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
      modelConfig: { ctx_size: 4096, tools: true },
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

// Streams one turn: thinking and answer text go to their own panels.
async function turn(history) {
  const result = completion({ modelId, history, tools, stream: true, captureThinking: true })
  if ($('#thinking').textContent) $('#thinking').textContent += '\n\n'
  for await (const event of result.events) {
    if (event.type === 'thinkingDelta') $('#thinking').textContent += event.text
    if (event.type === 'contentDelta') $('#output').textContent += event.text
  }
  return result.final
}

async function run() {
  $('#run').disabled = true
  for (const id of ['#thinking', '#tool-calls', '#output']) $(id).textContent = ''
  try {
    const history = [
      { role: 'system', content: 'You can call tools to look up weather and horoscopes.' },
      { role: 'user', content: $('#prompt').value }
    ]
    const first = await turn(history)
    if (first.toolCalls.length === 0) {
      log('▸ the model answered without calling a tool')
      return
    }

    // Send each tool result back, then let the model answer with them.
    history.push({
      role: 'assistant',
      content: first.contentText,
      toolCalls: first.toolCalls.map(({ id, name, arguments: args }) => ({
        id,
        name,
        arguments: args
      }))
    })
    for (const call of first.toolCalls) {
      const output = execute(call.name, call.arguments)
      $('#tool-calls').textContent +=
        `${call.name}(${JSON.stringify(call.arguments)}) → ${JSON.stringify(output)}\n`
      history.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify(output)
      })
    }
    $('#output').textContent = ''
    await turn(history)
    log(`▸ answered after ${first.toolCalls.length} tool calls`)
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
