'use strict'

const LlmLlamacpp = require('../index')
const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const os = require('bare-os')
const { downloadModel } = require('./utils')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  name: 'Qwen3-1.7B-Q4_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_0.gguf'
}

const TOOL_WEATHER = {
  type: 'function',
  name: 'getWeather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature units' }
    },
    required: ['city']
  }
}

const TOOL_CALCULATOR = {
  type: 'function',
  name: 'calculate',
  description: 'Perform a math calculation',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate' }
    },
    required: ['expression']
  }
}

function stripInternalBlocks (text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .trim()
}

function extractToolCalls (response) {
  const toolCalls = []
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match
  while ((match = toolCallRegex.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      toolCalls.push(parsed.name || parsed.function?.name || 'unknown')
    } catch (_) {}
  }
  return toolCalls
}

async function loadModel (dirPath, modelName, config) {
  const modelPath = path.join(dirPath, modelName)
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })
  await model.load()
  return { model }
}

async function runAndCollect (model, prompt, runOptions) {
  const response = await model.run(prompt, runOptions)
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return { output: chunks.join(''), stats: response.stats }
}

async function main () {
  console.log('Test: tool removal correctness with tools_at_end')
  console.log('='.repeat(70))
  console.log('')

  const [modelName, dirPath] = await downloadModel(MODEL.url, MODEL.name)
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '256',
    temp: '0.1',
    seed: '1',
    verbosity: '0',
    tools: 'true',
    tools_at_end: 'true'
  }

  const { model } = await loadModel(dirPath, modelName, config)
  const cachePath = path.join(dirPath, 'test-tool-removal.bin')
  try { fs.unlinkSync(cachePath) } catch (_) {}

  let lastResponse = null

  try {
    const cacheOpts = { cacheKey: cachePath }

    // ── Turn 1: provide getWeather, ask about weather ──
    console.log('── Turn 1: tools=[getWeather], ask about weather ──')
    const prompt1 = [
      { role: 'system', content: 'You are a helpful assistant. You must use tools when available. Do not answer without using a tool.' },
      { role: 'user', content: 'What is the weather in Paris?' },
      TOOL_WEATHER
    ]
    const r1 = await runAndCollect(model, prompt1, cacheOpts)
    lastResponse = stripInternalBlocks(r1.output)
    const calls1 = extractToolCalls(r1.output)
    console.log(`   Response tools called: [${calls1.join(', ') || 'none'}]`)
    console.log('   Expected: [getWeather]')
    console.log(`   ${calls1.includes('getWeather') ? 'PASS ✓' : 'FAIL ✗'}`)
    console.log('')

    // ── Turn 2: REMOVE getWeather, provide calculate instead ──
    console.log('── Turn 2: tools=[calculate] (getWeather REMOVED), ask to calculate ──')
    const prompt2 = [
      { role: 'assistant', content: lastResponse },
      { role: 'user', content: 'Calculate 256 * 128' },
      TOOL_CALCULATOR
    ]
    const r2 = await runAndCollect(model, prompt2, cacheOpts)
    lastResponse = stripInternalBlocks(r2.output)
    const calls2 = extractToolCalls(r2.output)
    console.log(`   Response tools called: [${calls2.join(', ') || 'none'}]`)
    console.log('   Expected: [calculate]')
    console.log(`   ${calls2.includes('calculate') && !calls2.includes('getWeather') ? 'PASS ✓' : 'FAIL ✗'}`)
    console.log('')

    // ── Turn 3: KEEP only calculate, ask about weather (should NOT call getWeather) ──
    console.log('── Turn 3: tools=[calculate] (getWeather still removed), ask about weather ──')
    console.log('   This is the KEY test: model should NOT call getWeather (it was removed)')
    const prompt3 = [
      { role: 'assistant', content: lastResponse },
      { role: 'user', content: 'What is the weather in London?' },
      TOOL_CALCULATOR
    ]
    const r3 = await runAndCollect(model, prompt3, cacheOpts)
    lastResponse = stripInternalBlocks(r3.output)
    const calls3 = extractToolCalls(r3.output)
    console.log(`   Response tools called: [${calls3.join(', ') || 'none'}]`)
    console.log('   Expected: NOT getWeather (it\'s not available)')
    const weatherLeak = calls3.includes('getWeather')
    console.log(`   ${weatherLeak ? 'FAIL ✗ — stale tool leak! getWeather was called despite being removed' : 'PASS ✓ — model did not call removed tool'}`)
    console.log('')

    // ── Turn 4: bring back getWeather, remove calculate, ask to calculate ──
    console.log('── Turn 4: tools=[getWeather] (calculate REMOVED), ask to calculate ──')
    console.log('   Model should NOT call calculate (it was removed)')
    const prompt4 = [
      { role: 'assistant', content: lastResponse },
      { role: 'user', content: 'Calculate 999 / 3' },
      TOOL_WEATHER
    ]
    const r4 = await runAndCollect(model, prompt4, cacheOpts)
    lastResponse = stripInternalBlocks(r4.output)
    const calls4 = extractToolCalls(r4.output)
    console.log(`   Response tools called: [${calls4.join(', ') || 'none'}]`)
    console.log('   Expected: NOT calculate (it\'s not available)')
    const calcLeak = calls4.includes('calculate')
    console.log(`   ${calcLeak ? 'FAIL ✗ — stale tool leak! calculate was called despite being removed' : 'PASS ✓ — model did not call removed tool'}`)
    console.log('')

    // ── Summary ──
    console.log('='.repeat(70))
    console.log('SUMMARY')
    console.log('='.repeat(70))
    const results = [
      { turn: 1, pass: calls1.includes('getWeather'), desc: 'getWeather available → called it' },
      { turn: 2, pass: calls2.includes('calculate') && !calls2.includes('getWeather'), desc: 'calculate available, getWeather removed → called calculate' },
      { turn: 3, pass: !weatherLeak, desc: 'getWeather removed → did NOT call it' },
      { turn: 4, pass: !calcLeak, desc: 'calculate removed → did NOT call it' }
    ]
    for (const r of results) {
      console.log(`  Turn ${r.turn}: ${r.pass ? 'PASS ✓' : 'FAIL ✗'} — ${r.desc}`)
    }
    const allPass = results.every(r => r.pass)
    console.log('')
    console.log(allPass
      ? '  ALL PASSED — tool trimming correctly prevents stale tool usage'
      : '  FAILURES DETECTED — removed tools leaked through the cache')
  } finally {
    await model.unload()
    try { fs.unlinkSync(cachePath) } catch (_) {}
  }
}

// ─── Same test but with tools_in_system (full replay) ──────────────────────

async function mainInSystem () {
  console.log('\n\n')
  console.log('Test: tool removal correctness with tools_in_system (full replay)')
  console.log('='.repeat(70))
  console.log('')

  const [modelName, dirPath] = await downloadModel(MODEL.url, MODEL.name)
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '256',
    temp: '0.1',
    seed: '1',
    verbosity: '0',
    tools: 'true',
    tools_at_end: 'false'
  }

  const { model } = await loadModel(dirPath, modelName, config)
  const cachePath = path.join(dirPath, 'test-tool-removal-insystem.bin')
  try { fs.unlinkSync(cachePath) } catch (_) {}

  const SYSTEM = 'You are a helpful assistant. You must use tools when available. Do not answer without using a tool.'
  const history = [] // accumulate {role, content} for replay

  try {
    const cacheOpts = { cacheKey: cachePath }

    // ── Turn 1: provide getWeather, ask about weather ──
    console.log('── Turn 1: tools=[getWeather], ask about weather ──')
    const prompt1 = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'What is the weather in Paris?' },
      TOOL_WEATHER
    ]
    const r1 = await runAndCollect(model, prompt1, cacheOpts)
    history.push({ role: 'user', content: 'What is the weather in Paris?' })
    history.push({ role: 'assistant', content: stripInternalBlocks(r1.output) })
    const calls1 = extractToolCalls(r1.output)
    console.log(`   Response tools called: [${calls1.join(', ') || 'none'}]`)
    console.log('   Expected: [getWeather]')
    console.log(`   ${calls1.includes('getWeather') ? 'PASS ✓' : 'FAIL ✗'}`)
    console.log('')

    // ── Turn 2: REMOVE getWeather, provide calculate — full replay ──
    console.log('── Turn 2: tools=[calculate] (getWeather REMOVED), ask to calculate ──')
    const prompt2 = [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: 'Calculate 256 * 128' },
      TOOL_CALCULATOR
    ]
    const r2 = await runAndCollect(model, prompt2)
    history.push({ role: 'user', content: 'Calculate 256 * 128' })
    history.push({ role: 'assistant', content: stripInternalBlocks(r2.output) })
    const calls2 = extractToolCalls(r2.output)
    console.log(`   Response tools called: [${calls2.join(', ') || 'none'}]`)
    console.log('   Expected: [calculate]')
    console.log(`   ${calls2.includes('calculate') && !calls2.includes('getWeather') ? 'PASS ✓' : 'FAIL ✗'}`)
    console.log('')

    // ── Turn 3: KEEP only calculate, ask about weather ──
    console.log('── Turn 3: tools=[calculate] (getWeather still removed), ask about weather ──')
    console.log('   This is the KEY test: model should NOT call getWeather (it was removed)')
    const prompt3 = [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: 'What is the weather in London?' },
      TOOL_CALCULATOR
    ]
    const r3 = await runAndCollect(model, prompt3)
    history.push({ role: 'user', content: 'What is the weather in London?' })
    history.push({ role: 'assistant', content: stripInternalBlocks(r3.output) })
    const calls3 = extractToolCalls(r3.output)
    console.log(`   Response tools called: [${calls3.join(', ') || 'none'}]`)
    console.log('   Expected: NOT getWeather (it\'s not available)')
    const weatherLeak = calls3.includes('getWeather')
    console.log(`   ${weatherLeak ? 'FAIL ✗ — stale tool leak! getWeather was called despite being removed' : 'PASS ✓ — model did not call removed tool'}`)
    console.log('')

    // ── Turn 4: bring back getWeather, remove calculate, ask to calculate ──
    console.log('── Turn 4: tools=[getWeather] (calculate REMOVED), ask to calculate ──')
    console.log('   Model should NOT call calculate (it was removed)')
    const prompt4 = [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: 'Calculate 999 / 3' },
      TOOL_WEATHER
    ]
    const r4 = await runAndCollect(model, prompt4)
    const calls4 = extractToolCalls(r4.output)
    console.log(`   Response tools called: [${calls4.join(', ') || 'none'}]`)
    console.log('   Expected: NOT calculate (it\'s not available)')
    const calcLeak = calls4.includes('calculate')
    console.log(`   ${calcLeak ? 'FAIL ✗ — stale tool leak! calculate was called despite being removed' : 'PASS ✓ — model did not call removed tool'}`)
    console.log('')

    // ── Summary ──
    console.log('='.repeat(70))
    console.log('SUMMARY (tools_in_system, full replay)')
    console.log('='.repeat(70))
    const results = [
      { turn: 1, pass: calls1.includes('getWeather'), desc: 'getWeather available → called it' },
      { turn: 2, pass: calls2.includes('calculate') && !calls2.includes('getWeather'), desc: 'calculate available, getWeather removed → called calculate' },
      { turn: 3, pass: !weatherLeak, desc: 'getWeather removed → did NOT call it' },
      { turn: 4, pass: !calcLeak, desc: 'calculate removed → did NOT call it' }
    ]
    for (const r of results) {
      console.log(`  Turn ${r.turn}: ${r.pass ? 'PASS ✓' : 'FAIL ✗'} — ${r.desc}`)
    }
    const allPass = results.every(r => r.pass)
    console.log('')
    console.log(allPass
      ? '  ALL PASSED — tool switching correctly prevents stale tool usage'
      : '  FAILURES DETECTED — removed tools leaked from conversation history')
  } finally {
    await model.unload()
    try { fs.unlinkSync(cachePath) } catch (_) {}
  }
}

async function runAll () {
  await main()
  await mainInSystem()
}

runAll().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
