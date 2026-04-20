'use strict'

const LlamaClient = require('../../../index')
const process = require('bare-process')
const path = require('bare-path')
const fs = require('bare-fs')
const { downloadModel } = require('../../utils')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const LORA_ADAPTER = './smart-home-lora/trained-lora-adapter.gguf'

if (!fs.existsSync(LORA_ADAPTER)) {
  console.error(`LoRA adapter not found at ${LORA_ADAPTER}`)
  console.error('Run smart-home-finetune.js first to train the adapter.')
  process.exit(1)
}

const SYSTEM_PROMPT = 'You are a specialized Home Automation Controller. ' +
  'You must ONLY output valid JSON. Do not engage in conversation. ' +
  'If the user\'s request requires an action, output a JSON array of tool calls. ' +
  'Available tools: [get_camera_live_feed(camera_id, stream_quality), ' +
  'control_smart_light(device_id, command), ' +
  'set_thermostat_temperature(device_id, temperature), ' +
  'lock_all_smart_doors(confirmation_required)]. ' +
  'If the request is unclear, output {"error": "clarification_needed"}.'

const KNOWN_TOOLS = [
  'get_camera_live_feed', 'control_smart_light',
  'set_thermostat_temperature', 'lock_all_smart_doors'
]

function separator (char, len) {
  return char.repeat(len || 70)
}

function analyzeResponse (raw) {
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/)
  const thinkContent = thinkMatch ? thinkMatch[1].trim() : null
  const thinkTokens = thinkContent ? thinkContent.split(/\s+/).length : 0

  let payload = raw
  if (thinkMatch) {
    payload = raw.slice(raw.indexOf('</think>') + '</think>'.length).trim()
  }

  const usedTools = []
  const hallucinated = []
  const validToolsUsed = []
  let isStructured = false

  // Try parsing <tool_call> XML blocks (training data format)
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let tcMatch
  while ((tcMatch = toolCallRegex.exec(payload)) !== null) {
    isStructured = true
    let body = tcMatch[1].trim()
    body = body.replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
    try {
      const parsed = JSON.parse(body)
      const name = parsed.name
      if (name) {
        usedTools.push(name)
        if (KNOWN_TOOLS.includes(name)) validToolsUsed.push(name)
        else hallucinated.push(name)
      }
    } catch (_) {}
  }

  // Fallback: try JSON array (raw or markdown-wrapped)
  if (!isStructured) {
    let jsonStr = payload

    const mdMatch = payload.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
    if (mdMatch) {
      jsonStr = mdMatch[1].trim()
    }

    try {
      const parsed = JSON.parse(jsonStr)
      if (Array.isArray(parsed)) {
        isStructured = true
        for (const call of parsed) {
          const name = call.tool || call.name || call.function
          if (!name) continue
          usedTools.push(name)
          if (KNOWN_TOOLS.includes(name)) validToolsUsed.push(name)
          else hallucinated.push(name)
        }
      }
    } catch (_) {}
  }

  const isConversational = !isStructured && payload.length > 0
  const strictness = isStructured && !isConversational
  const accuracy = usedTools.length > 0
    ? validToolsUsed.length / usedTools.length
    : (isStructured ? 1.0 : 0.0)

  return {
    raw,
    thinkContent,
    thinkTokens,
    payload,
    isStructured,
    isConversational,
    usedTools,
    validToolsUsed,
    hallucinated,
    strictness,
    accuracy
  }
}

function printAnalysis (label, analysis) {
  console.log(`\n  --- ${label} ---`)
  console.log(`  Strictness:          ${analysis.strictness ? 'PASS (structured tool calls)' : 'FAIL (no valid tool calls)'}`)
  console.log(`  Thinking length:     ${analysis.thinkTokens > 0 ? '~' + analysis.thinkTokens + ' tokens' : 'none'}`)
  console.log(`  Accuracy:            ${(analysis.accuracy * 100).toFixed(0)}% (${analysis.validToolsUsed.length}/${analysis.usedTools.length} valid tools)`)
  if (analysis.isConversational) {
    console.log('  Drift:               Reverted to conversational text')
  }
  if (analysis.hallucinated.length > 0) {
    console.log(`  Hallucinated tools:  ${analysis.hallucinated.join(', ')}`)
  }
}

async function runScenario (client, messages) {
  const response = await client.run(messages)
  let fullResponse = ''
  await response.onUpdate(token => {
    process.stdout.write(token)
    fullResponse += token
  }).await()
  console.log('')
  return fullResponse
}

async function main () {
  const [modelName, modelDir] = await downloadModel(MODEL.url, MODEL.name)

  const modelPath = path.join(modelDir, modelName)

  const sharedConfig = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    temp: '0.0',
    n_predict: '512',
    repeat_penalty: '1.3'
  }

  const baselineConfig = { ...sharedConfig }
  const config = { ...sharedConfig, lora: LORA_ADAPTER }

  const promptA = 'I want to check the live feed from my front door camera in 1080p quality.'
  const promptB = "I'm heading to work. Please lock all the smart doors, turn off the living room light, and set the thermostat to 62 degrees."
  const promptC1 = 'Turn on the living room light.'
  const promptC2 = 'Actually, turn it off instead and set the thermostat to 70.'

  let baselineClient
  let client
  let baseAll

  try {
    // ============================================================
    //  PART 1: BASELINE (no LoRA adapter)
    // ============================================================
    try {
      console.log(separator('='))
      console.log('  PART 1: BASELINE  (No LoRA Adapter)')
      console.log('  Model: ' + MODEL.name)
      console.log(separator('='))

      baselineClient = new LlamaClient({
        files: { model: [modelPath] },
        config: baselineConfig,
        logger: console,
        opts: { stats: true }
      })
      await baselineClient.load()
      console.log('Base model loaded (no LoRA).\n')

      console.log('System Prompt:')
      console.log('  ' + SYSTEM_PROMPT + '\n')

      console.log(separator('='))
      console.log('  BASELINE A: Easy Test')
      console.log(separator('='))
      console.log(`Input: "${promptA}"\n`)
      console.log('Response:')
      const baseA = await runScenario(baselineClient, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptA }
      ])
      const baseAnalysisA = analyzeResponse(baseA)
      printAnalysis('Baseline A', baseAnalysisA)

      console.log('\n' + separator('='))
      console.log('  BASELINE B: Complex Test')
      console.log(separator('='))
      console.log(`Input: "${promptB}"\n`)
      console.log('Response:')
      const baseB = await runScenario(baselineClient, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptB }
      ])
      const baseAnalysisB = analyzeResponse(baseB)
      printAnalysis('Baseline B', baseAnalysisB)

      console.log('\n' + separator('='))
      console.log('  BASELINE C: Multi-Turn Test')
      console.log(separator('='))
      console.log(`Turn 1 Input: "${promptC1}"\n`)
      console.log('Turn 1 Response:')
      const baseC1 = await runScenario(baselineClient, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptC1 }
      ])
      const baseAnalysisC1 = analyzeResponse(baseC1)
      printAnalysis('Baseline C / Turn 1', baseAnalysisC1)

      console.log(`\nTurn 2 Input: "${promptC2}"\n`)
      console.log('Turn 2 Response:')
      const baseC2 = await runScenario(baselineClient, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptC1 },
        { role: 'assistant', content: baseC1 },
        { role: 'user', content: promptC2 }
      ])
      const baseAnalysisC2 = analyzeResponse(baseC2)
      printAnalysis('Baseline C / Turn 2', baseAnalysisC2)

      baseAll = [
        { id: 'A', name: 'Easy', analysis: baseAnalysisA },
        { id: 'B', name: 'Complex', analysis: baseAnalysisB },
        { id: 'C1', name: 'Multi-Turn T1', analysis: baseAnalysisC1 },
        { id: 'C2', name: 'Multi-Turn T2', analysis: baseAnalysisC2 }
      ]
    } finally {
      if (baselineClient) {
        try {
          console.log('\nUnloading base model...')
          await baselineClient.unload()
        } catch (e) { console.error('Failed to unload baseline:', e) }
      }
    }

    // ============================================================
    //  PART 2: FINETUNED (with LoRA adapter)
    // ============================================================
    try {
      console.log('\n' + separator('='))
      console.log('  PART 2: FINETUNED  (With LoRA Adapter)')
      console.log('  Model:   ' + MODEL.name)
      console.log('  Adapter: ' + LORA_ADAPTER)
      console.log(separator('='))

      client = new LlamaClient({
        files: { model: [modelPath] },
        config,
        logger: console,
        opts: { stats: true }
      })
      await client.load()
      console.log('Model + LoRA adapter loaded.\n')

      // ---- Finetuned A ----
      console.log(separator('='))
      console.log('  FINETUNED A: Easy Test')
      console.log(separator('='))
      console.log(`Input: "${promptA}"\n`)
      console.log('Response:')
      const responseA = await runScenario(client, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptA }
      ])
      const analysisA = analyzeResponse(responseA)
      printAnalysis('Finetuned A', analysisA)

      // ---- Finetuned B ----
      console.log('\n' + separator('='))
      console.log('  FINETUNED B: Complex Test')
      console.log(separator('='))
      console.log(`Input: "${promptB}"\n`)
      console.log('Response:')
      const responseB = await runScenario(client, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptB }
      ])
      const analysisB = analyzeResponse(responseB)
      printAnalysis('Finetuned B', analysisB)

      // ---- Finetuned C ----
      console.log('\n' + separator('='))
      console.log('  FINETUNED C: Multi-Turn Test')
      console.log(separator('='))
      console.log(`Turn 1 Input: "${promptC1}"\n`)
      console.log('Turn 1 Response:')
      const responseC1 = await runScenario(client, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptC1 }
      ])
      const analysisC1 = analyzeResponse(responseC1)
      printAnalysis('Finetuned C / Turn 1', analysisC1)

      console.log(`\nTurn 2 Input: "${promptC2}"\n`)
      console.log('Turn 2 Response:')
      const responseC2 = await runScenario(client, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptC1 },
        { role: 'assistant', content: responseC1 },
        { role: 'user', content: promptC2 }
      ])
      const analysisC2 = analyzeResponse(responseC2)
      printAnalysis('Finetuned C / Turn 2', analysisC2)

      // ---- Finetuned Report ----
      const all = [
        { id: 'A', name: 'Easy', analysis: analysisA },
        { id: 'B', name: 'Complex', analysis: analysisB },
        { id: 'C1', name: 'Multi-Turn T1', analysis: analysisC1 },
        { id: 'C2', name: 'Multi-Turn T2', analysis: analysisC2 }
      ]

      const strictPass = all.filter(s => s.analysis.strictness).length
      const totalThink = all.reduce((sum, s) => sum + s.analysis.thinkTokens, 0)
      const avgThink = Math.round(totalThink / all.length)
      const avgAccuracy = all.reduce((sum, s) => sum + s.analysis.accuracy, 0) / all.length
      const multiTurnStable = analysisC2.strictness

      const baseStrictPass = baseAll ? baseAll.filter(s => s.analysis.strictness).length : 0
      const baseTotalThink = baseAll ? baseAll.reduce((sum, s) => sum + s.analysis.thinkTokens, 0) : 0
      const baseAvgThink = baseAll ? Math.round(baseTotalThink / baseAll.length) : 0
      const baseAvgAccuracy = baseAll ? baseAll.reduce((sum, s) => sum + s.analysis.accuracy, 0) / baseAll.length : 0
      const baseMultiTurn = baseAll ? baseAll[3].analysis.strictness : false

      console.log('\n' + separator('='))
      console.log('  COMPARISON REPORT: Baseline vs Finetuned')
      console.log(separator('='))

      console.log('\n  Per-scenario breakdown:')
      console.log('  ' + '-'.repeat(72))
      console.log('  Scenario             Baseline     Finetuned    Think (B/F)')
      console.log('  ' + '-'.repeat(72))
      for (let i = 0; i < all.length; i++) {
        const f = all[i]
        const b = baseAll ? baseAll[i] : null
        const bStrict = b ? (b.analysis.strictness ? 'PASS' : 'FAIL') : '---'
        const fStrict = f.analysis.strictness ? 'PASS' : 'FAIL'
        const bThink = b ? (b.analysis.thinkTokens > 0 ? '~' + b.analysis.thinkTokens : '0') : '---'
        const fThink = f.analysis.thinkTokens > 0 ? '~' + f.analysis.thinkTokens : '0'
        console.log(`  ${(f.id + ' ' + f.name).padEnd(21)} ${bStrict.padEnd(13)}${fStrict.padEnd(13)}${bThink} -> ${fThink}`)
      }
      console.log('  ' + '-'.repeat(72))

      console.log('\n  Aggregate:')
      console.log('  ' + '-'.repeat(55))
      console.log(`    Strictness:          ${baseStrictPass}/${all.length} -> ${strictPass}/${all.length}`)
      console.log(`    Avg think tokens:    ~${baseAvgThink} -> ~${avgThink}`)
      console.log(`    Avg accuracy:        ${(baseAvgAccuracy * 100).toFixed(0)}% -> ${(avgAccuracy * 100).toFixed(0)}%`)
      console.log(`    Multi-turn stable:   ${baseMultiTurn ? 'YES' : 'NO'} -> ${multiTurnStable ? 'YES' : 'NO'}`)
      console.log('  ' + '-'.repeat(55))

      console.log('\n' + separator('='))

      const reportDir = path.dirname(LORA_ADAPTER)
      fs.mkdirSync(reportDir, { recursive: true })
      const reportPath = path.join(reportDir, 'finetuned_report.json')
      const report = {
        model: MODEL.name,
        lora_adapter: LORA_ADAPTER,
        timestamp: new Date().toISOString(),
        system_prompt_length: SYSTEM_PROMPT.length,
        scenarios: all.map(s => ({
          id: s.id,
          name: s.name,
          strictness: s.analysis.strictness,
          think_tokens: s.analysis.thinkTokens,
          accuracy: s.analysis.accuracy,
          tools_used: s.analysis.usedTools,
          hallucinated_tools: s.analysis.hallucinated,
          conversational_drift: s.analysis.isConversational,
          raw_response: s.analysis.raw
        })),
        aggregate: {
          strictness_pass_rate: strictPass / all.length,
          avg_think_tokens: avgThink,
          avg_accuracy: avgAccuracy,
          multi_turn_stable: multiTurnStable
        }
      }
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
      console.log(`  Report saved to: ${reportPath}`)
      console.log(separator('='))
    } finally {
      if (client) {
        try {
          console.log('\nCleaning up...')
          await client.unload()
          console.log('Done.')
        } catch (e) { console.error('Failed to unload finetuned client:', e) }
      }
    }
  } catch (error) {
    console.error('\nTest failed:', error.message)
    console.error('Stack:', error.stack)
    process.exit(1)
  }
}

main().catch(error => {
  console.error('\nFatal error:', error.message)
  process.exit(1)
})
