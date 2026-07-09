'use strict'

// Realistic 3-turn conversation on Qwen3-0.6B (pure attention) with
// cacheKey. Tests whether `remove_thinking_from_context` causes
// degradation on a *normal* multi-turn chat — not the arithmetic
// chain that's pathologically dependent on prior reasoning.

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../index.js')

const MODEL_PATH = process.env.QWEN_MODEL ||
    path.resolve(__dirname, '../test/model/Qwen3-0.6B-Q8_0.gguf')

// A normal-feeling 3-turn chat where each turn refers loosely back to
// the topic but doesn't require prior reasoning to answer correctly.
const CHAIN = [
  { prompt: 'What is the capital of France?', mustContain: 'Paris' },
  { prompt: 'What is a famous landmark there?', mustContain: 'Eiffel' },
  { prompt: 'In which century was it built?', mustContain: ['19th', '1800', 'nineteenth'] }
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
    `../test/model/qwen3-normal-${label.toLowerCase()}-${Date.now()}.bin`)
  try { fs.unlinkSync(cacheKey) } catch (_) {}

  const turns = []
  for (let i = 0; i < CHAIN.length; i++) {
    const { prompt, mustContain } = CHAIN[i]
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
    const accept = Array.isArray(mustContain) ? mustContain : [mustContain]
    const correct = closed && accept.some(s => visible.toLowerCase().includes(s.toLowerCase()))

    conversation.push({ role: 'assistant', content: response })
    turns.push({
      idx: i + 1,
      prompt,
      mustContain: accept.join(' / '),
      response,
      reasoning,
      visible,
      stats,
      closed,
      correct
    })
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
    console.log(`\n--- Turn ${t.idx} | "${t.prompt}" ---`)
    console.log(`  must contain: ${t.mustContain}`)
    console.log(`  visible      : "${t.visible}"`)
    console.log(`  closed=${t.closed} correct=${t.correct} ` +
      `cacheTokens=${t.stats.CacheTokens || '?'} ` +
      `gen=${t.stats.generatedTokens || '?'} ` +
      `discards=${t.stats.thinkingBlockDiscards || 0}`)
    console.log('  reasoning summary (first 250 chars):')
    console.log(`    ${t.reasoning.slice(0, 250).replace(/\n/g, ' / ')}`)
  }
}

async function main () {
  console.log('[diag] Normal 3-turn conversation, Qwen3-0.6B pure attention\n')

  const offTurns = await runChain('OFF', false)
  console.log('[diag] OFF complete.')
  const onTurns = await runChain('ON', true)
  console.log('[diag] ON complete.')

  dump('OFF (no compaction)', offTurns)
  dump('ON  (compaction active)', onTurns)

  console.log(`\n${'='.repeat(70)}`)
  console.log('  Verdict')
  console.log('='.repeat(70))
  const offAll = offTurns.every(t => t.correct)
  const onAll = onTurns.every(t => t.correct)
  console.log(`  OFF all turns correct: ${offAll}`)
  console.log(`  ON  all turns correct: ${onAll}`)
  if (offAll && onAll) {
    console.log('  → No degradation on normal conversation. Compaction is safe for typical chat.')
  } else if (offAll && !onAll) {
    console.log('  → ON path degrades on normal conversation. Real bug.')
  } else if (!offAll) {
    console.log('  → OFF baseline failed. Test needs adjustment or model is too weak.')
  }
}

main().catch(err => { console.error('[diag] fatal:', err); process.exit(3) })
