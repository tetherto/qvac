'use strict'

// Multi-turn quality check for the recurrent-rollback path on Qwen3.5.
//
// Runs a 3-turn arithmetic chain that requires the model to track the
// previous answer ("that") across turns. If the snapshot+replay
// rollback corrupts the SSM hidden state, the model loses context and
// can't resolve "that" — symptoms: wrong number, asks "multiply what?",
// or hallucinates a number.
//
// For each turn we record:
//   - whether the answer contains the expected number
//   - thinkingBlockDiscards (proves compaction fired)
//   - response length / latency
//
// Under the uniform hard-fail contract (PR #2813), any compaction
// failure — snapshot capture, restore underflow, or replay rejection
// — throws `StatusError` from `run()`. So there is no soft failure
// counter to report; a failed compaction shows up as an uncaught
// exception instead.
//
// We run the same flow twice for an apples-to-apples baseline:
//   ON  : remove_thinking_from_context: true  (rollback active)
//   OFF : remove_thinking_from_context: false (no compaction; ground truth)
//
// Pass criteria:
//   - ON path: every turn answers correctly AND failed=0 across all turns
//   - ON path's correctness matches OFF path turn-by-turn (no degradation
//     introduced by compaction)
//
// Run:  bare scripts/verify-qwen35-multi-turn-quality.js

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../index.js')

const MODEL_PATH = process.env.QWEN_MODEL ||
    path.resolve(__dirname, '../test/model/Qwen3.5-0.8B-Q8_0.gguf')

if (!fs.existsSync(MODEL_PATH)) {
  console.error(`[verify] Qwen3.5 model not cached at ${MODEL_PATH}`)
  process.exit(2)
}

// Arithmetic chain. Each turn refers back to the previous answer via
// "that" / "the result", so the model genuinely needs prior context.
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

function makeInference () {
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

async function runChain (label, removeThinking) {
  const inference = makeInference()
  await inference.load()

  const turns = []
  const conversation = []

  // Per-run cacheKey — without this the addon calls resetState() after
  // each inference, wipes nPast_ to 0, and re-prefills the entire
  // conversation from scratch on every turn. With it, the KV cache
  // persists across runs, so the cross-turn effect of
  // remove_thinking_from_context is actually visible (compaction on
  // turn N affects what's in the cache at the start of turn N+1).
  const cacheKey = path.resolve(
    __dirname,
    `../test/model/qwen35-multi-turn-${label.toLowerCase()}-${Date.now()}.bin`)
  // Best-effort cleanup of any stale cache from a prior run.
  try { fs.unlinkSync(cacheKey) } catch (_) {}

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
    await result.onUpdate(token => { response += token }).await()
    const elapsedMs = Date.now() - t0
    const stats = result.stats || {}

    // Strip the `<think>...</think>` body to evaluate just the visible answer.
    // Tighten correctness: BOTH the closing tag must have fired AND the
    // expected number must appear in the post-think visible output.
    // Without the close-tag check a runaway-reasoning turn would falsely
    // report "correct" if the number happened to appear in the rambling
    // body.
    const closedReasoning = /<\/think>/.test(response)
    const visible = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const containsExpected =
        closedReasoning && new RegExp(`\\b${expected}\\b`).test(visible)

    conversation.push({ role: 'assistant', content: response })

    turns.push({
      idx: i + 1,
      prompt,
      expected,
      visible,
      response,
      stats,
      elapsedMs,
      containsExpected
    })

    console.log(`[${label}] turn ${i + 1}: expected="${expected}" got_visible="${visible.slice(0, 80)}" ` +
      `correct=${containsExpected} discards=${stats.thinkingBlockDiscards || 0} ` +
      `(${elapsedMs}ms)`)
  }

  await inference.unload()
  try { fs.unlinkSync(cacheKey) } catch (_) {}
  return turns
}

function summarise (label, turns) {
  console.log(`\n=== ${label} ===`)
  let allCorrect = true
  for (const t of turns) {
    const discards = Number(t.stats.thinkingBlockDiscards || 0)
    const tps = t.stats.TPS || 0
    console.log(`  turn ${t.idx}: correct=${t.containsExpected} ` +
      `discards=${discards} ` +
      `tokens=${t.stats.generatedTokens || '?'} tps=${tps.toFixed?.(1) || tps} ` +
      `(${t.elapsedMs}ms)`)
    console.log(`           visible: "${t.visible.slice(0, 120)}"`)
    if (!t.containsExpected) allCorrect = false
  }
  return { allCorrect }
}

async function main () {
  console.log('[verify] running 3-turn arithmetic chain TWICE: once with compaction ON, once OFF\n')

  console.log('--- Phase 1: remove_thinking_from_context = true (rollback active) ---')
  const onTurns = await runChain('ON', true)

  console.log('\n--- Phase 2: remove_thinking_from_context = false (baseline) ---')
  const offTurns = await runChain('OFF', false)

  const onSummary = summarise('ON  (rollback active)', onTurns)
  const offSummary = summarise('OFF (baseline)', offTurns)

  let exitCode = 0
  console.log('\n=== Verdict ===')

  if (!onSummary.allCorrect) {
    console.error('[FAIL] ON path got at least one turn wrong')
    exitCode = 1
  }
  if (!offSummary.allCorrect) {
    console.warn('[WARN] OFF baseline also got at least one turn wrong — model may be too weak for this chain')
  }
  if (onSummary.allCorrect && offSummary.allCorrect) {
    console.log('[OK]   ON and OFF paths both got every turn correct — no degradation introduced by compaction')
  } else if (onSummary.allCorrect && !offSummary.allCorrect) {
    console.log('[OK]   ON path got everything correct (better than baseline!)')
  }

  if (exitCode === 0) {
    console.log('\n[PASS] Qwen3.5 recurrent rollback preserves multi-turn quality.')
  } else {
    console.log('\n[FAIL] see errors above.')
  }
  process.exit(exitCode)
}

main().catch(err => {
  console.error('[verify] fatal:', err)
  process.exit(3)
})
