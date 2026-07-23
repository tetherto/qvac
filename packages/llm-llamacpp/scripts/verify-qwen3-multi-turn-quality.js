'use strict'

// Pure-attention 3-turn baseline: identical to the Qwen3.5 quality
// check but on Qwen3-0.6B (pure attention KV, no recurrent half).
// This isolates the SSM-rollback variable: if pure attention also
// degrades on turn 3 with cache+chain-reasoning, the issue is generic
// (small model on a multi-turn chain). If pure attention is fine, the
// degradation we saw on Qwen3.5 is specific to the recurrent rollback.
//
// Run:  bare scripts/verify-qwen3-multi-turn-quality.js

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../index.js')

const MODEL_PATH =
  process.env.QWEN_MODEL || path.resolve(__dirname, '../test/model/Qwen3-0.6B-Q8_0.gguf')

if (!fs.existsSync(MODEL_PATH)) {
  console.error(`[verify] Qwen3 model not cached at ${MODEL_PATH}`)
  process.exit(2)
}

const CHAIN = [
  {
    prompt: 'What is 7 + 5? Reply with the number only.',
    expected: '12'
  },
  {
    prompt: 'Multiply that by 2. Reply with the number only.',
    expected: '24'
  },
  {
    prompt: 'Subtract 4 from the result. Reply with the number only.',
    expected: '20'
  }
]

function makeInference() {
  return new LlmLlamacpp({
    files: { model: [MODEL_PATH] },
    config: {
      ctx_size: '32768',
      n_predict: '12288',
      seed: '50',
      gpu_layers: '999',
      temp: '0',
      top_p: '1',
      device: 'gpu',
      verbosity: '2',
      tools: 'false'
    },
    logger: console,
    opts: { stats: true }
  })
}

async function runChain(label, removeThinking) {
  const inference = makeInference()
  await inference.load()

  const turns = []
  const conversation = []
  const cacheKey = path.resolve(
    __dirname,
    `../test/model/qwen3-multi-turn-${label.toLowerCase()}-${Date.now()}.bin`
  )
  try {
    fs.unlinkSync(cacheKey)
  } catch (_) {}

  for (let i = 0; i < CHAIN.length; i++) {
    const { prompt, expected } = CHAIN[i]
    conversation.push({ role: 'user', content: prompt })

    const t0 = Date.now()
    const result = await inference.run(conversation, {
      cacheKey,
      saveCacheToDisk: true,
      generationParams: { remove_thinking_from_context: removeThinking }
    })
    let response = ''
    await result
      .onUpdate((token) => {
        response += token
      })
      .await()
    const elapsedMs = Date.now() - t0
    const stats = result.stats || {}

    const closedReasoning = /<\/think>/.test(response)
    const visible = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const containsExpected = closedReasoning && new RegExp(`\\b${expected}\\b`).test(visible)

    conversation.push({ role: 'assistant', content: response })

    turns.push({
      idx: i + 1,
      prompt,
      expected,
      visible,
      response,
      stats,
      elapsedMs,
      containsExpected,
      closedReasoning
    })

    console.log(
      `[${label}] turn ${i + 1}: closed=${closedReasoning} ` +
        `correct=${containsExpected} ` +
        `discards=${stats.thinkingBlockDiscards || 0} ` +
        `tokens=${stats.generatedTokens || '?'} (${elapsedMs}ms)`
    )
  }

  await inference.unload()
  try {
    fs.unlinkSync(cacheKey)
  } catch (_) {}
  return turns
}

function summarise(label, turns) {
  console.log(`\n=== ${label} ===`)
  let allCorrect = true
  for (const t of turns) {
    const discards = Number(t.stats.thinkingBlockDiscards || 0)
    const tps = t.stats.TPS || 0
    console.log(
      `  turn ${t.idx}: closed=${t.closedReasoning} ` +
        `correct=${t.containsExpected} discards=${discards} ` +
        `tokens=${t.stats.generatedTokens || '?'} ` +
        `tps=${typeof tps === 'number' ? tps.toFixed(1) : tps} ` +
        `(${t.elapsedMs}ms)`
    )
    console.log(`           visible: "${t.visible.slice(0, 120)}"`)
    if (!t.containsExpected) allCorrect = false
  }
  return allCorrect
}

async function main() {
  console.log('[verify] running 3-turn arithmetic chain on Qwen3-0.6B (pure attention)\n')

  console.log('--- Phase 1: remove_thinking_from_context = true ---')
  const onTurns = await runChain('ON', true)
  console.log('\n--- Phase 2: remove_thinking_from_context = false ---')
  const offTurns = await runChain('OFF', false)

  const onAllCorrect = summarise('ON  (compaction active)', onTurns)
  const offAllCorrect = summarise('OFF (baseline)', offTurns)

  console.log('\n=== Verdict ===')
  if (onAllCorrect && offAllCorrect) {
    console.log('[PASS] Pure-attention 3-turn chain works correctly with and without compaction.')
    console.log(
      '       This is the baseline against which the Qwen3.5 hybrid path should be judged.'
    )
  } else if (!onAllCorrect && !offAllCorrect) {
    console.log(
      '[BASELINE FAIL] Pure attention also fails on this chain — small-model variance, not a hybrid-rollback issue.'
    )
  } else if (onAllCorrect) {
    console.log('[?] ON correct, OFF wrong — model variability.')
  } else {
    console.log(
      '[REGRESSION] Pure-attention compaction breaks the chain. Pre-existing bug, not something we introduced.'
    )
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[verify] fatal:', err)
  process.exit(3)
})
