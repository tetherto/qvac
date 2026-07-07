'use strict'

// Diagnostic: run the same 3-turn arithmetic chain on Qwen3 (pure
// attention) with cacheKey, both ON and OFF, and dump:
//
//   - full reasoning body for each turn (so we can read what the
//     model thought it knew)
//   - per-turn nPast / cacheTokens / generatedTokens
//   - whether the model lost track of prior context (e.g. "the
//     result" resolves to wrong number)
//
// The point is to figure out WHY turn 3 ON gives the wrong answer
// while turn 3 OFF gives the correct one.

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../index.js')

const MODEL_PATH = path.resolve(__dirname, '../test/model/Qwen3-0.6B-Q8_0.gguf')

const CHAIN = [
  { prompt: 'What is 7 + 5? Reply with the number only.', expected: '12' },
  { prompt: 'Multiply that by 2. Reply with the number only.', expected: '24' },
  { prompt: 'Subtract 4 from the result. Reply with the number only.', expected: '20' }
]

function makeInference () {
  return new LlmLlamacpp({
    files: { model: [MODEL_PATH] },
    config: {
      ctx_size: '8192',
      n_predict: '2048',
      seed: '50',
      gpu_layers: '999',
      temp: '0',
      top_p: '1',
      device: 'gpu',
      // Lower verbosity so the model output is easy to find
      verbosity: '0',
      tools: 'false'
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    opts: { stats: true }
  })
}

async function runChain (label, removeThinking) {
  const inference = makeInference()
  await inference.load()

  const conversation = []
  const cacheKey = path.resolve(
    __dirname,
    `../test/model/qwen3-diag-${label.toLowerCase()}-${Date.now()}.bin`)
  try { fs.unlinkSync(cacheKey) } catch (_) {}

  const turns = []
  for (let i = 0; i < CHAIN.length; i++) {
    const { prompt, expected } = CHAIN[i]
    conversation.push({ role: 'user', content: prompt })

    const result = await inference.run(conversation, {
      cacheKey,
      saveCacheToDisk: true,
      generationParams: { remove_thinking_from_context: removeThinking }
    })
    let response = ''
    await result.onUpdate(token => { response += token }).await()
    const stats = result.stats || {}

    const closed = /<\/think>/.test(response)
    const visible = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const reasoningMatch = response.match(/<think>([\s\S]*?)<\/think>/)
    const reasoning = reasoningMatch ? reasoningMatch[1] : ''
    const correct =
        closed && new RegExp(`\\b${expected}\\b`).test(visible)

    conversation.push({ role: 'assistant', content: response })
    turns.push({ idx: i + 1, prompt, expected, response, reasoning, visible, stats, closed, correct })
  }

  await inference.unload()
  try { fs.unlinkSync(cacheKey) } catch (_) {}
  return turns
}

function dump (label, turns) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`  ${label}`)
  console.log('='.repeat(70))
  for (const t of turns) {
    console.log(`\n--- Turn ${t.idx} | expected="${t.expected}" | answered="${t.visible}" | correct=${t.correct} ---`)
    const stats = t.stats
    console.log(`  cacheTokens=${stats.CacheTokens || '?'} ` +
      `generatedTokens=${stats.generatedTokens || '?'} ` +
      `promptTokens=${stats.promptTokens || '?'} ` +
      `discards=${stats.thinkingBlockDiscards || 0}`)
    console.log(`  reasoning body (${t.reasoning.length} chars):`)
    // Print the reasoning body indented so it's easy to scan
    const lines = t.reasoning.split('\n').filter(l => l.trim())
    for (const line of lines) {
      console.log(`    ${line}`)
    }
  }
}

async function main () {
  console.log('[diag] running 3-turn arithmetic chain on Qwen3-0.6B...\n')

  const onTurns = await runChain('ON', true)
  console.log('[diag] ON path complete.')
  const offTurns = await runChain('OFF', false)
  console.log('[diag] OFF path complete.')

  dump('OFF (no compaction) — baseline', offTurns)
  dump('ON  (compaction active) — degraded', onTurns)

  console.log(`\n${'='.repeat(70)}`)
  console.log('  Compare turn 3 reasoning side-by-side')
  console.log('='.repeat(70))
  console.log('OFF turn 3 reasoning:')
  console.log(offTurns[2].reasoning)
  console.log('\nON turn 3 reasoning:')
  console.log(onTurns[2].reasoning)
}

main().catch(err => {
  console.error('[diag] fatal:', err)
  process.exit(3)
})
