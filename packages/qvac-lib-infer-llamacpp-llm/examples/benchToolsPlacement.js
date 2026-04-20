'use strict'

const LlmLlamacpp = require('../index')
const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const os = require('bare-os')
const { downloadModel } = require('./utils')

// ─── Configuration ──────────────────────────────────────────────────────────

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  name: 'Qwen3-1.7B-Q4_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_0.gguf'
}

const NUM_TURNS = 20

// ─── Tool definitions ───────────────────────────────────────────────────────

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

const TOOL_SEARCH = {
  type: 'function',
  name: 'searchWeb',
  description: 'Search the web for information',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'integer', minimum: 1, maximum: 10, description: 'Max results' }
    },
    required: ['query']
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

const TOOL_TRANSLATE = {
  type: 'function',
  name: 'translateText',
  description: 'Translate text to another language',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to translate' },
      targetLang: { type: 'string', description: 'Target language code (e.g. fr, es, de)' }
    },
    required: ['text', 'targetLang']
  }
}

const TOOL_EMAIL = {
  type: 'function',
  name: 'sendEmail',
  description: 'Send an email to a recipient',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body content' }
    },
    required: ['to', 'subject', 'body']
  }
}

const TOOL_REMINDER = {
  type: 'function',
  name: 'setReminder',
  description: 'Set a reminder for a specific time',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Reminder message' },
      time: { type: 'string', description: 'Time for the reminder (ISO 8601)' }
    },
    required: ['message', 'time']
  }
}

// Different tools per turn (for scenario C — dynamic tools)
const DYNAMIC_TOOLS_PER_TURN = [
  [TOOL_WEATHER, TOOL_SEARCH], // Turn 1: weather + search
  [TOOL_CALCULATOR], // Turn 2: calculator only
  [TOOL_TRANSLATE], // Turn 3: translate only
  [TOOL_EMAIL, TOOL_REMINDER], // Turn 4: email + reminder
  [TOOL_WEATHER], // Turn 5: weather only
  [TOOL_SEARCH, TOOL_CALCULATOR], // Turn 6: search + calculator
  [TOOL_TRANSLATE, TOOL_EMAIL], // Turn 7: translate + email
  [TOOL_REMINDER, TOOL_WEATHER, TOOL_SEARCH], // Turn 8: reminder + weather + search
  [TOOL_CALCULATOR, TOOL_TRANSLATE], // Turn 9: calculator + translate
  [TOOL_EMAIL], // Turn 10: email only
  [TOOL_WEATHER, TOOL_CALCULATOR], // Turn 11: weather + calculator
  [TOOL_SEARCH], // Turn 12: search only
  [TOOL_REMINDER, TOOL_TRANSLATE], // Turn 13: reminder + translate
  [TOOL_WEATHER, TOOL_EMAIL], // Turn 14: weather + email
  [TOOL_CALCULATOR, TOOL_SEARCH], // Turn 15: calculator + search
  [TOOL_TRANSLATE], // Turn 16: translate only
  [TOOL_REMINDER, TOOL_EMAIL, TOOL_WEATHER], // Turn 17: reminder + email + weather
  [TOOL_SEARCH, TOOL_TRANSLATE], // Turn 18: search + translate
  [TOOL_CALCULATOR], // Turn 19: calculator only
  [TOOL_WEATHER, TOOL_REMINDER] // Turn 20: weather + reminder
]

const CONVERSATION_TURNS_DYNAMIC = [
  { user: 'What is the weather in Paris?' },
  { user: 'Calculate 156 * 23' },
  { user: 'Translate "hello world" to French' },
  { user: 'Send an email to bob@example.com about the meeting tomorrow' },
  { user: 'What is the weather in London?' },
  { user: 'Search for AI news and calculate 999 / 3' },
  { user: 'Translate "good morning" to Spanish and email the result to alice@example.com' },
  { user: 'Set a reminder to check the weather in Berlin tomorrow and search for flight deals' },
  { user: 'Calculate 2^10 and translate the result to German' },
  { user: 'Send an email to team@example.com with a summary of today\'s tasks' },
  { user: 'What is the weather in Tokyo and calculate 42 * 17' },
  { user: 'Search for latest Python tutorials' },
  { user: 'Set a reminder for lunch at noon and translate "thank you" to Japanese' },
  { user: 'What is the weather in Sydney and email the forecast to weather@example.com' },
  { user: 'Calculate the square root of 144 and search for math resources' },
  { user: 'Translate "goodbye" to Italian' },
  { user: 'Set a reminder to call the dentist, email jane@example.com about it, and check weather in Rome' },
  { user: 'Search for healthy recipes and translate the top result to Portuguese' },
  { user: 'Calculate 365 * 24' },
  { user: 'What is the weather in Berlin and set a reminder to pack an umbrella' }
]

// ─── Tool call extraction & validation ──────────────────────────────────────

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

function validateToolCalls (turnIndex, output, availableTools) {
  const calledTools = extractToolCalls(output)
  const availableNames = availableTools.map(t => t.name)
  const violations = []

  for (const called of calledTools) {
    if (!availableNames.includes(called)) {
      violations.push(called)
    }
  }

  const status = violations.length === 0 ? 'OK' : 'VIOLATION'
  return {
    status,
    calledTools,
    availableNames,
    violations
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeBaseConfig (toolsAtEnd) {
  return {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '256',
    temp: '0.1',
    seed: '1',
    verbosity: '0',
    tools: 'true',
    tools_at_end: toolsAtEnd ? 'true' : 'false'
  }
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
  await response
    .onUpdate(data => { chunks.push(data) })
    .await()
  return {
    output: chunks.join(''),
    stats: response.stats
  }
}

function hrMs (hrtime) {
  return (hrtime[0] * 1e3 + hrtime[1] / 1e6).toFixed(2)
}

function cleanCache (cachePath) {
  try { fs.unlinkSync(cachePath) } catch (_) {}
}

// ─── Generic scenario runner ────────────────────────────────────────────────

async function runScenario (dirPath, modelName, opts) {
  const { name, toolsAtEnd, dynamicTools, conversationTurns, getToolsForTurn, cacheName } = opts

  console.log('\n' + '='.repeat(70))
  console.log(name)
  console.log('='.repeat(70))

  const config = makeBaseConfig(toolsAtEnd)
  const { model } = await loadModel(dirPath, modelName, config)
  const cachePath = path.join(dirPath, cacheName)
  cleanCache(cachePath)

  const turnStats = []
  const toolValidations = []
  let lastAssistantResponse = null
  // For tools_in_system with dynamic tools: track full conversation history for replay
  const conversationHistory = []

  try {
    for (let i = 0; i < NUM_TURNS; i++) {
      const turn = conversationTurns[i]
      const turnTools = getToolsForTurn(i)
      let prompt

      let runOptions = { cacheKey: cachePath }

      if (toolsAtEnd) {
        // tools_at_end: session cache + re-send last assistant response + new user + tools
        prompt = [
          ...(i === 0
            ? [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: turn.user }]
            : [
                ...(lastAssistantResponse ? [{ role: 'assistant', content: lastAssistantResponse }] : []),
                { role: 'user', content: turn.user }
              ]),
          ...turnTools
        ]
      } else if (dynamicTools) {
        // tools_in_system with changing tools: omit cacheKey and replay full history with new tools
        if (i > 0) runOptions = {}
        prompt = [
          { role: 'system', content: 'You are a helpful assistant.' },
          ...conversationHistory,
          { role: 'user', content: turn.user },
          ...turnTools
        ]
      } else {
        // tools_in_system with same tools: session cache + only new user msg (tools cached from turn 1)
        prompt = [
          ...(i === 0
            ? [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: turn.user }]
            : [{ role: 'user', content: turn.user }]),
          ...(i === 0 ? turnTools : [])
        ]
      }

      const t0 = process.hrtime()
      const result = await runAndCollect(model, prompt, runOptions)
      const elapsed = process.hrtime(t0)
      lastAssistantResponse = stripInternalBlocks(result.output)

      // Track history for replay in tools_in_system dynamic mode
      conversationHistory.push({ role: 'user', content: turn.user })
      conversationHistory.push({ role: 'assistant', content: stripInternalBlocks(result.output) })

      const validation = validateToolCalls(i, result.output, turnTools)
      toolValidations.push(validation)

      turnStats.push({
        turn: i + 1,
        wallMs: hrMs(elapsed),
        promptTokens: result.stats?.promptTokens || 0,
        generatedTokens: result.stats?.generatedTokens || 0,
        cacheTokens: result.stats?.CacheTokens || 0,
        ttft: result.stats?.TTFT || 0,
        tps: result.stats?.TPS || 0
      })

      const toolStatus = validation.status === 'OK' ? 'OK' : `VIOLATION: called [${validation.violations.join(', ')}]`
      const calledStr = validation.calledTools.length > 0 ? validation.calledTools.join(', ') : 'none'
      const availStr = validation.availableNames.join(', ')

      console.log(
        `  Turn ${i + 1}: wall=${hrMs(elapsed)}ms  prompt=${turnStats[i].promptTokens}  ` +
        `gen=${turnStats[i].generatedTokens}  cache=${turnStats[i].cacheTokens}  ` +
        `TTFT=${turnStats[i].ttft}ms  TPS=${turnStats[i].tps}`
      )
      console.log(
        `         tools=[${availStr}]  called=[${calledStr}]  validation=${toolStatus}`
      )
    }
  } finally {
    await model.unload()
    cleanCache(cachePath)
  }

  return { turnStats, toolValidations }
}

// ─── Summary ────────────────────────────────────────────────────────────────

function printComparison (labelA, statsA, labelB, statsB) {
  console.log('\n' + '='.repeat(80))
  console.log(`COMPARISON: ${labelA} (A) vs ${labelB} (B)`)
  console.log('='.repeat(80))
  console.log('')
  console.log('Turn | Wall A (ms) | Wall B (ms) | Δ ms     | Prompt A | Prompt B | Cache A | Cache B | TTFT A  | TTFT B')
  console.log('-----|-------------|-------------|----------|----------|----------|---------|---------|---------|--------')

  let totalA = 0
  let totalB = 0

  for (let i = 0; i < statsA.length; i++) {
    const a = statsA[i]
    const b = statsB[i]
    const delta = (parseFloat(a.wallMs) - parseFloat(b.wallMs)).toFixed(2)
    totalA += parseFloat(a.wallMs)
    totalB += parseFloat(b.wallMs)

    const ttftA = typeof a.ttft === 'number' ? a.ttft.toFixed(0) : String(a.ttft)
    const ttftB = typeof b.ttft === 'number' ? b.ttft.toFixed(0) : String(b.ttft)

    console.log(
      `  ${a.turn}  ` +
      `| ${a.wallMs.padStart(11)} ` +
      `| ${b.wallMs.padStart(11)} ` +
      `| ${delta.padStart(8)} ` +
      `| ${String(a.promptTokens).padStart(8)} ` +
      `| ${String(b.promptTokens).padStart(8)} ` +
      `| ${String(a.cacheTokens).padStart(7)} ` +
      `| ${String(b.cacheTokens).padStart(7)} ` +
      `| ${ttftA.padStart(7)} ` +
      `| ${ttftB.padStart(7)}`
    )
  }

  console.log('-----|-------------|-------------|----------|----------|----------|---------|---------|---------|--------')
  console.log(
    ' TOT ' +
    `| ${totalA.toFixed(2).padStart(11)} ` +
    `| ${totalB.toFixed(2).padStart(11)} ` +
    `| ${(totalA - totalB).toFixed(2).padStart(8)} |`
  )
  console.log('')

  const pctDiff = ((totalA - totalB) / totalB * 100).toFixed(1)
  if (totalA > totalB) {
    console.log(`  → A is ${pctDiff}% SLOWER overall (${(totalA - totalB).toFixed(0)}ms extra across ${NUM_TURNS} turns)`)
  } else {
    console.log(`  → A is ${Math.abs(pctDiff)}% FASTER overall (${(totalB - totalA).toFixed(0)}ms saved across ${NUM_TURNS} turns)`)
  }
}

function printToolValidationSummary (label, validations) {
  console.log(`\n─── Tool Call Validation: ${label} ───`)
  let allOk = true
  for (let i = 0; i < validations.length; i++) {
    const v = validations[i]
    const icon = v.status === 'OK' ? 'PASS' : 'FAIL'
    if (v.status !== 'OK') allOk = false

    if (v.calledTools.length === 0) {
      console.log(`  Turn ${i + 1} [${icon}]: no tool calls  (available: ${v.availableNames.join(', ')})`)
    } else if (v.violations.length > 0) {
      console.log(`  Turn ${i + 1} [${icon}]: called [${v.calledTools.join(', ')}]  available [${v.availableNames.join(', ')}]  STALE TOOLS USED: [${v.violations.join(', ')}]`)
    } else {
      console.log(`  Turn ${i + 1} [${icon}]: called [${v.calledTools.join(', ')}]  (available: ${v.availableNames.join(', ')})`)
    }
  }
  console.log(`  Result: ${allOk ? 'ALL PASSED — no stale/trimmed tools were called' : 'FAILURES DETECTED — model called tools that should have been trimmed'}`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main () {
  console.log('Benchmark: tools_at_end vs tools_in_system — performance & correctness')
  console.log(`Model: ${MODEL.name}`)
  console.log(`Turns: ${NUM_TURNS}`)
  console.log(`Device: ${useCpu ? 'CPU' : 'GPU'}`)

  const [modelName, dirPath] = await downloadModel(MODEL.url, MODEL.name)

  // // ── Scenario A: tools_at_end, same tools every turn ──
  // const resultA = await runScenario(dirPath, modelName, {
  //   name: 'SCENARIO A: tools_at_end = true, SAME tools every turn',
  //   toolsAtEnd: true,
  //   conversationTurns: CONVERSATION_TURNS_FIXED,
  //   getToolsForTurn: () => FIXED_TOOLS,
  //   cacheName: 'bench-A-at-end-same.bin'
  // })

  // // ── Scenario B: tools_in_system (standard), same tools every turn ──
  // const resultB = await runScenario(dirPath, modelName, {
  //   name: 'SCENARIO B: tools_at_end = false (standard), SAME tools every turn',
  //   toolsAtEnd: false,
  //   conversationTurns: CONVERSATION_TURNS_FIXED,
  //   getToolsForTurn: () => FIXED_TOOLS,
  //   cacheName: 'bench-B-in-system-same.bin'
  // })

  // ── Scenario C: tools_at_end with dynamic tools ──
  const resultC = await runScenario(dirPath, modelName, {
    name: 'SCENARIO C: tools_at_end = true, DIFFERENT tools each turn',
    toolsAtEnd: true,
    dynamicTools: true,
    conversationTurns: CONVERSATION_TURNS_DYNAMIC,
    getToolsForTurn: (i) => DYNAMIC_TOOLS_PER_TURN[i],
    cacheName: 'bench-C-at-end-dynamic.bin'
  })

  // ── Scenario D: tools_in_system with dynamic tools (must replay each turn) ──
  const resultD = await runScenario(dirPath, modelName, {
    name: 'SCENARIO D: tools_at_end = false, DIFFERENT tools each turn (full replay)',
    toolsAtEnd: false,
    dynamicTools: true,
    conversationTurns: CONVERSATION_TURNS_DYNAMIC,
    getToolsForTurn: (i) => DYNAMIC_TOOLS_PER_TURN[i],
    cacheName: 'bench-D-in-system-dynamic.bin'
  })

  // ── Comparisons ──
  console.log('\n' + '#'.repeat(80))
  console.log('#  RESULTS SUMMARY')
  console.log('#'.repeat(80))

  printComparison(
    'tools_at_end (dynamic tools)',
    resultC.turnStats,
    'tools_in_system (dynamic tools, full replay)',
    resultD.turnStats
  )

  // ── Tool validation summary ──
  console.log('\n' + '#'.repeat(80))
  console.log('#  TOOL CALL CORRECTNESS')
  console.log('#'.repeat(80))

  printToolValidationSummary('Scenario C — tools_at_end, dynamic tools', resultC.toolValidations)
  printToolValidationSummary('Scenario D — tools_in_system, dynamic tools (full replay)', resultD.toolValidations)

  console.log('\n' + '─'.repeat(80))
  console.log('Key:')
  console.log('  Scenario C: tools_at_end=true with dynamic tools — trims & re-sends prev response')
  console.log('  Scenario D: tools_at_end=false with dynamic tools — replay full history without cache')
  console.log('  PASS = model only called tools available in that turn')
  console.log('  FAIL = model called a tool from a previous turn (stale/trimmed tool leak)')
  console.log('─'.repeat(80))

  // ── ASCII Graph: wall time per turn ──
  console.log('\n' + '#'.repeat(80))
  console.log('#  TIME (ms) vs TURN — tools_at_end (C) vs tools_in_system+replay (D)')
  console.log('#'.repeat(80))
  console.log('')

  const BAR_WIDTH = 50
  const allTimes = [
    ...resultC.turnStats.map(s => parseFloat(s.wallMs)),
    ...resultD.turnStats.map(s => parseFloat(s.wallMs))
  ]
  const maxTime = Math.max(...allTimes)

  function makeBar (value, max, width) {
    const filled = Math.round((value / max) * width)
    return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled)
  }

  console.log('Turn |  C (ms)  |  D (ms)  | Graph')
  console.log('-----|----------|----------|' + '-'.repeat(BAR_WIDTH * 2 + 14))

  for (let i = 0; i < resultC.turnStats.length; i++) {
    const cMs = parseFloat(resultC.turnStats[i].wallMs)
    const dMs = parseFloat(resultD.turnStats[i].wallMs)
    const cBar = makeBar(cMs, maxTime, BAR_WIDTH)
    const dBar = makeBar(dMs, maxTime, BAR_WIDTH)
    console.log(
      `  ${String(i + 1).padStart(2)} ` +
      `| ${String(Math.round(cMs)).padStart(8)} ` +
      `| ${String(Math.round(dMs)).padStart(8)} ` +
      `| C:${cBar} D:${dBar}`
    )
  }
  console.log('')
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
