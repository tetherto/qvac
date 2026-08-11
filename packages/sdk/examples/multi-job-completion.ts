/**
 * Multi-job continuous batching — concurrent completions on one loaded LLM.
 *
 * Unlike `batchCompletion()` (which bundles many prompts into ONE call), this
 * shows independent `completion()` calls fired concurrently against the SAME
 * loaded model. When the model is loaded with `modelConfig.parallel >= 2`, the
 * SDK admits up to `parallel` completions at once and the llama.cpp addon
 * decodes their sequences together — so a burst of prompts finishes in roughly
 * the time of the slowest one, not the sum of all of them.
 *
 * Each `completion()` returns an independent `CompletionRun`:
 *  - `events`     — an `AsyncIterable` of streamed events for that call.
 *  - `final`      — a `Promise<CompletionFinal>` with THIS call's own
 *                   `contentText` and `stats` (its own tokens/sec, TTFT).
 *                   `stats.avgConcurrentSeq` stays model-level (how busy the
 *                   shared backend was).
 *  - `requestId`  — cancel just this call with `cancel({ requestId })`; peers
 *                   keep decoding.
 *
 * Non-cached completions and batches share the model's `parallel` admission
 * cap: with `parallel` in flight, admitting one more waits FIFO until a slot
 * frees.
 *
 * Run from packages/sdk:
 *   bun run examples/multi-job-completion.ts
 */

import { completion, cancel, loadModel, unloadModel, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk'

const PROMPTS = [
  { id: 'cherry', ask: 'Reply with only the word CHERRY.' },
  { id: 'banana', ask: 'Reply with only the word BANANA.' },
  { id: 'grape', ask: 'Reply with only the word GRAPE.' },
  { id: 'lemon', ask: 'Reply with only the word LEMON.' }
]

try {
  // `parallel: 4` opens the concurrent decode slots continuous batching needs.
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: 'llm',
    modelConfig: { ctx_size: 4096, parallel: 4 },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  // ---- Concurrent completions. Fire every call before awaiting any, so all
  // four are admitted and decode together (not one-after-another). ----
  console.log('\n▸ Firing 4 completions concurrently:')
  const started = Date.now()
  const runs = PROMPTS.map(({ ask }) =>
    completion({
      modelId,
      history: [{ role: 'user', content: ask }],
      generationParams: { temp: 0, seed: 42, predict: 16 },
      stream: true
    })
  )

  const outputs = await Promise.all(
    runs.map(async (run, i) => {
      const final = await run.final
      return {
        id: PROMPTS[i]!.id,
        text: final.contentText.replace(/\s+/g, ' ').trim(),
        stats: final.stats
      }
    })
  )
  const elapsed = Date.now() - started

  for (const { id, text, stats } of outputs) {
    const tps = stats?.tokensPerSecond?.toFixed(1) ?? 'n/a'
    console.log(`  ▸ ${id}: "${text}"  (own ${tps} tok/s)`)
  }
  console.log(`\n▸ All 4 finished in ${elapsed} ms of wall-clock (decoded together, not serially).`)

  // ---- Per-request cancel isolation. Fire two more; cancel only the first by
  // its requestId. The second must still complete. ----
  console.log('\n▸ Per-request cancel: cancelling one of two in-flight completions:')
  const doomed = completion({
    modelId,
    history: [{ role: 'user', content: 'Write a long story about an otter.' }],
    generationParams: { temp: 0, seed: 1, predict: 256 },
    stream: true
  })
  const survivor = completion({
    modelId,
    history: [{ role: 'user', content: 'Reply with only the word MELON.' }],
    generationParams: { temp: 0, seed: 42, predict: 16 },
    stream: true
  })

  await cancel({ requestId: doomed.requestId })

  let doomedOutcome = 'completed'
  try {
    await doomed.final
  } catch {
    doomedOutcome = 'cancelled'
  }
  const survivorText = (await survivor.final).contentText.replace(/\s+/g, ' ').trim()
  console.log(`  ▸ cancelled run -> ${doomedOutcome}`)
  console.log(`  ▸ peer run kept decoding -> "${survivorText}"`)

  await unloadModel({ modelId, clearStorage: false })
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
