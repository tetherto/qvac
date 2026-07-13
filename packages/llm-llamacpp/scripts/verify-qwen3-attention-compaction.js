'use strict'

// Pure-attention path regression check: runs Qwen3-0.6B (pure attention,
// no recurrent memory) through the same two-turn flow as the Qwen3.5
// verifier and asserts compaction still works via the existing
// seq_rm + seq_add path — our changes must not have broken it.

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../index.js')

const MODEL_PATH = path.resolve(__dirname, '../test/model/Qwen3-0.6B-Q8_0.gguf')

if (!fs.existsSync(MODEL_PATH)) {
  console.error(`[verify] Qwen3 model not cached at ${MODEL_PATH}`)
  process.exit(2)
}

async function main() {
  console.log(`[verify] loading ${path.basename(MODEL_PATH)} (pure attention)...`)
  const inference = new LlmLlamacpp({
    files: { model: [MODEL_PATH] },
    config: {
      ctx_size: '8192',
      n_predict: '3072',
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

  await inference.load()
  console.log('[verify] model loaded')

  const messages = [{ role: 'user', content: 'What is 7 + 5? Reply with the number only.' }]

  async function runOne(label, msgs) {
    console.log(`[verify] turn ${label}: remove_thinking_from_context: true ...`)
    const result = await inference.run(msgs, {
      generationParams: { remove_thinking_from_context: true }
    })
    let response = ''
    await result
      .onUpdate((token) => {
        response += token
      })
      .await()
    return { response, stats: result.stats || {} }
  }

  const t1 = await runOne('1', messages)
  const followUp = [
    ...messages,
    { role: 'assistant', content: t1.response },
    { role: 'user', content: 'Now multiply that by 2.' }
  ]
  const t2 = await runOne('2', followUp)

  console.log('\n=== Qwen3 (pure attention) result ===')
  console.log(`turn 1 stats: ${JSON.stringify(t1.stats)}`)
  console.log(`turn 2 stats: ${JSON.stringify(t2.stats)}`)

  const toNum = (v) => (typeof v === 'number' ? v : Number(v || 0))
  const t1Discards = toNum(t1.stats.thinkingBlockDiscards)

  let exitCode = 0
  // Under the uniform hard-fail contract (PR #2813), any compaction
  // failure — including a pure-attention `seq_rm + seq_add` rejection
  // — throws `StatusError` from `run()`. Reaching this point means
  // both turns' compaction succeeded (or was a no-op because the
  // model never emitted a reasoning block).
  //
  // The compaction itself must still fire as before.
  if (t1Discards < 1) {
    console.error('[FAIL] turn 1 should drop at least one reasoning block ' + `(got ${t1Discards})`)
    exitCode = 1
  }

  if (exitCode === 0) {
    console.log('\n[PASS] Qwen3 pure-attention compaction unchanged.')
    console.log(`       turn1: discards=${t1Discards}`)
  }

  await inference.unload()
  process.exit(exitCode)
}

main().catch((err) => {
  console.error('[verify] fatal:', err)
  process.exit(3)
})
