/**
 * Batch completion — continuous batching over a single loaded LLM.
 *
 * `batchCompletion()` submits multiple prompts to one loaded model in a single
 * call so the llama.cpp addon can decode the active sequences together. Load the
 * model with `modelConfig.parallel >= 2` to make the concurrent slots available.
 *
 * The returned `BatchCompletionRun` exposes:
 *  - `events`     — a merged `AsyncIterable<{ id, event }>` across all prompts.
 *  - `byId(id)`   — per-prompt `events` and a `final` aggregation for one prompt.
 *  - `ids`        — a `Promise<string[]>` of addon-assigned ids in prompt order.
 *  - `results`    — a `Promise<BatchCompletionResult[]>` in prompt order. It is
 *                   ALL-OR-NOTHING for stream-level failures: if the batch
 *                   handler throws (e.g. a context overflow) the whole run
 *                   rejects and no per-prompt finals can be recovered. Graceful
 *                   terminal events such as cancellation still settle each
 *                   `byId(id).final` according to that id's terminal state.
 *  - `stats`      — a `Promise<CompletionStats | undefined>`. Stats are
 *                   BATCH-LEVEL: the addon aggregates decode metrics across the
 *                   whole batch (e.g. `avgConcurrentSeq`, total tokens), so they
 *                   surface once here rather than per prompt. Per-prompt
 *                   `final.stats` is intentionally left undefined.
 *
 * Each prompt may additionally carry (not shown here to keep the run fast/cheap):
 *  - `tools` / `mcp`  — per-prompt tools; handlers attach only to tool calls
 *                       produced by that prompt. Requires a tool-capable model
 *                       loaded with `modelConfig.tools: true` (e.g. Qwen). See
 *                       the `tools/` examples for the tool-calling surface.
 *  - `attachments`    — the same multimodal attachments `completion()` supports,
 *                       when the loaded model has a projection model.
 *  - `responseFormat` — `json_object` / `json_schema` (cannot be combined with
 *                       `tools` or `mcp`, which already constrain output).
 *
 * Run from packages/sdk:
 *   bun run examples/batch-completion.ts
 */

import { batchCompletion, loadModel, unloadModel, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk'

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

  const run = batchCompletion({
    modelId,
    prompts: [
      {
        id: 'cherry',
        history: [{ role: 'user', content: 'Reply with only the word CHERRY.' }],
        generationParams: { temp: 0, seed: 42, predict: 16 }
      },
      {
        id: 'banana',
        history: [{ role: 'user', content: 'Reply with only the word BANANA.' }],
        generationParams: { temp: 0, seed: 42, predict: 16 }
      },
      {
        id: 'grape',
        history: [{ role: 'user', content: 'Reply with only the word GRAPE.' }],
        generationParams: { temp: 0, seed: 42, predict: 16 }
      }
    ]
  })

  console.log('\n▸ Merged event stream (interleaved across prompts):')
  for await (const { id, event } of run.events) {
    if (event.type === 'contentDelta') {
      process.stdout.write(`[${id}] ${event.text}`)
    }
  }

  // `results` is ordered by prompt and all-or-nothing on stream-level failure.
  const results = await run.results
  console.log('\n\n▸ Ordered results:')
  for (const { id, final } of results) {
    console.log(`  ▸ ${id}: ${final.contentText.replace(/\s+/g, ' ').trim()}`)
  }

  // Per-prompt aggregation is also available directly via `byId(id)`.
  const ids = await run.ids
  const firstFinal = await run.byId(ids[0]!).final
  console.log(`\n▸ byId("${ids[0]}").final -> ${firstFinal.contentText.trim()}`)

  // Batch-level stats (a single CompletionStats for the whole run, or undefined).
  const stats = await run.stats
  if (stats) {
    console.log(`\n▸ Batch stats: ${stats.tokensPerSecond?.toFixed(1)} tok/s across the batch`)
  }

  await unloadModel({ modelId, clearStorage: false })
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
