'use strict'

// One-shot verification for the recurrent / hybrid-SSM thinking-block
// compaction path. Loads Qwen3.5-0.8B (already cached under
// `test/model/`), runs one completion with
// `remove_thinking_from_context: true`, and reports whether the
// snapshot + restore + replay path succeeded.
//
// Pass criteria:
//   - the `run()` call resolves without throwing (under the uniform
//     hard-fail contract in PR #2813, any compaction failure —
//     snapshot capture, restore underflow, or replay rejection —
//     throws `StatusError` from `run()`)
//   - response is non-empty
//   - stats.thinkingBlockDiscards >= 1   (the model actually emitted
//     a `<think>` block AND we dropped it)
//
// Run:  bare scripts/verify-qwen35-recurrent-compaction.js

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../index.js')

const MODEL_PATH = process.env.QWEN_MODEL
  ? path.resolve(process.env.QWEN_MODEL)
  : path.resolve(__dirname, '../test/model/Qwen3.5-0.8B-Q8_0.gguf')

if (!fs.existsSync(MODEL_PATH)) {
  console.error(`[verify] Qwen3.5 model not cached at ${MODEL_PATH}`)
  console.error('         Run any reasoning.test.js test first to download it.')
  process.exit(2)
}

async function main() {
  console.log(`[verify] loading ${path.basename(MODEL_PATH)}...`)
  // Generous ctx_size + n_predict so Qwen3.5-0.8B has room to close its
  // `</think>` block. Small Qwen3.5 variants tend to ramble; if the
  // budget runs out before close, the span stays open and the
  // compactor correctly does nothing — but that does not exercise the
  // recurrent path. We need a closed span.
  const inference = new LlmLlamacpp({
    files: { model: [MODEL_PATH] },
    config: {
      ctx_size: '16384',
      n_predict: '12288',
      seed: '50',
      gpu_layers: '999',
      temp: '0',
      top_p: '1',
      device: 'gpu',
      verbosity: '3',
      tools: 'false'
    },
    logger: console,
    opts: { stats: true }
  })

  await inference.load()
  console.log('[verify] model loaded')

  // Use Qwen3.5's standard chat-template forced opener (the addon
  // detects `<think>\n` in the rendered prompt suffix and tracks the
  // span from prefill). The model only needs to emit `</think>` for
  // compaction to fire — the open is already in the cache.
  const messages = [{ role: 'user', content: 'What is 7 + 5? Reply with the number only.' }]

  async function runOne(label, msgs) {
    console.log(`[verify] turn ${label}: running with remove_thinking_from_context: true ...`)
    const t0 = Date.now()
    const result = await inference.run(msgs, {
      generationParams: { remove_thinking_from_context: true }
    })
    let response = ''
    await result
      .onUpdate((token) => {
        response += token
      })
      .await()
    return { response, stats: result.stats || {}, elapsedMs: Date.now() - t0 }
  }

  // Turn 1: exercise the snapshot+replay path.
  const turn1 = await runOne('1', messages)
  // Turn 2: sanity check that the cache is coherent post-compaction so
  // the model can keep generating on follow-ups.
  const followUp = [
    ...messages,
    { role: 'assistant', content: turn1.response },
    { role: 'user', content: 'Now multiply that by 2.' }
  ]
  const turn2 = await runOne('2', followUp)

  // Surface aggregated results.
  const response = turn1.response
  const stats = turn1.stats
  const elapsedMs = turn1.elapsedMs

  // Surface think-tag presence so a 0 discard count can be diagnosed
  // (model never closed) vs (close fired but compaction skipped).
  const hasOpen = response.includes('<think>')
  const closeIdx = response.indexOf('</think>')
  const hasClose = closeIdx !== -1

  console.log('\n=== Verification result ===')
  console.log(`elapsed: ${elapsedMs} ms`)
  console.log(`response length: ${response.length} chars`)
  console.log(
    `<think> present: ${hasOpen}; </think> present: ${hasClose}` +
      (hasClose ? ` at idx ${closeIdx}` : '')
  )
  console.log(`response head: ${response.slice(0, 200)}${response.length > 200 ? '...' : ''}`)
  if (hasClose) {
    console.log(`response tail (post-close): ${response.slice(closeIdx, closeIdx + 300)}`)
  }
  console.log(`stats: ${JSON.stringify(stats, null, 2)}`)

  const toNum = (v) => (typeof v === 'number' ? v : Number(v || 0))
  const discards = toNum(stats.thinkingBlockDiscards)

  let exitCode = 0
  if (response.length === 0) {
    console.error('[FAIL] response is empty')
    exitCode = 1
  }
  if (discards < 1) {
    console.error(`[FAIL] thinkingBlockDiscards=${discards} (expected >= 1)`)
    console.error('       Either no `<think>` block was emitted, or compaction skipped silently.')
    exitCode = 1
  }

  // Turn-2 coherence check: the cache must be in a usable state after
  // turn-1's compaction, so turn-2 produces non-empty output. Under
  // the uniform hard-fail contract, any compaction failure on turn 2
  // would have thrown from `runOne` above, so reaching this point
  // means turn 2's compaction (if any) also succeeded.
  if (turn2.response.length === 0) {
    console.error('[FAIL] turn 2 response is empty — compacted cache may be corrupt')
    exitCode = 1
  }
  console.log(
    `turn 2 (len=${turn2.response.length}, ${turn2.elapsedMs} ms) head: ${turn2.response.slice(0, 200)}`
  )
  console.log(`turn 2 stats: ${JSON.stringify(turn2.stats)}`)

  if (exitCode === 0) {
    console.log('\n[PASS] Qwen3.5 recurrent-state snapshot + replay path is working.')
    console.log(`       turn1: discards=${discards}`)
    console.log(`       turn2: discards=${toNum(turn2.stats.thinkingBlockDiscards)}`)
  }

  await inference.unload()
  process.exit(exitCode)
}

main().catch((err) => {
  console.error('[verify] fatal:', err)
  process.exit(3)
})
