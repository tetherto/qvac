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
 * Completions and batches share the model's `parallel` admission cap: with
 * `parallel` in flight, admitting one more waits FIFO until a slot frees.
 *
 * Run from packages/sdk:
 *   bun run examples/multi-job-completion.ts
 */

import {
  completion,
  cancel,
  loadModel,
  unloadModel,
  InferenceCancelledError,
  LLAMA_3_2_1B_INST_Q4_0
} from '@qvac/sdk'

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
  // Report the engine's own measure of overlap rather than inferring it from
  // wall-clock: avgConcurrentSeq > 1 means the addon decoded sequences together.
  const peakConcurrent = Math.max(...outputs.map((o) => o.stats?.avgConcurrentSeq ?? 0))
  console.log(
    `\n▸ All 4 finished in ${elapsed} ms; engine avg concurrent sequences: ${peakConcurrent.toFixed(1)} (> 1 = decoded together).`
  )

  // ---- Per-request cancel isolation. Fire two long runs; cancel only the
  // first by its requestId. The second must keep decoding past the cancel. ----
  console.log('\n▸ Per-request cancel: cancelling one of two in-flight completions:')
  const doomed = completion({
    modelId,
    history: [{ role: 'user', content: 'Write a long story about an otter.' }],
    generationParams: { temp: 0, seed: 1, predict: 256 },
    stream: true
  })
  const survivor = completion({
    modelId,
    history: [{ role: 'user', content: 'Write a long story about a melon.' }],
    generationParams: { temp: 0, seed: 42, predict: 256 },
    stream: true
  })

  // Consume the survivor's stream directly so we can count tokens produced AFTER
  // the cancel is acknowledged — a short survivor could otherwise finish before
  // the cancel lands and pass even under a model-wide cancel.
  const survivorTokens = survivor.events[Symbol.asyncIterator]()

  // Wait until BOTH runs are actually streaming before cancelling, so the cancel
  // hits a genuinely in-flight peer, not a pre-admission drop.
  await Promise.all([doomed.events[Symbol.asyncIterator]().next(), survivorTokens.next()])

  await cancel({ requestId: doomed.requestId })

  let doomedCancelled = false
  try {
    await doomed.final
  } catch (err) {
    doomedCancelled = err instanceof InferenceCancelledError
  }

  // Drain what the survivor emits from here on: a per-request cancel leaves it
  // decoding to completion, a model-wide cancel would have stopped it.
  let tokensAfterCancel = 0
  for (let next = await survivorTokens.next(); !next.done; next = await survivorTokens.next()) {
    tokensAfterCancel++
  }
  const survivorText = (await survivor.final).contentText.replace(/\s+/g, ' ').trim()
  console.log(`  ▸ cancelled run -> ${doomedCancelled ? 'cancelled' : 'NOT cancelled'}`)
  console.log(`  ▸ peer kept decoding -> +${tokensAfterCancel} tokens after the cancel ack`)

  await unloadModel({ modelId, clearStorage: false })

  // A zero exit must prove concurrent scheduling, typed cancellation, and survivor
  // isolation: the first burst reported multiple resident sequences, the doomed
  // run cancelled, and its peer produced tokens AFTER the cancel landed.
  if (peakConcurrent <= 1 || !doomedCancelled || tokensAfterCancel === 0) {
    console.error(
      `✖ multi-job behavior not demonstrated (peakConcurrent=${peakConcurrent.toFixed(2)}, doomedCancelled=${doomedCancelled}, tokensAfterCancel=${tokensAfterCancel}, survivorText="${survivorText}")`
    )
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
