/**
 * Demonstrates `stopReason` on `CompletionFinal`.
 *
 * `completion()` sets `stopReason` on the aggregated `final` promise to
 * indicate why the model stopped generating:
 *
 *  - `undefined`    — natural end-of-sequence (EOS). The model finished on
 *                     its own. This is the common case and the backwards-
 *                     compatible default.
 *  - `"length"`     — the `predict` token budget was exhausted. Output is
 *                     truncated; the model did not reach a natural stopping
 *                     point.
 *  - `"cancelled"`  — the request was cancelled via `cancel({ requestId })`.
 *                     See `cancel-by-request-id.ts` for the full cancel flow.
 *
 * This example shows the two non-cancel cases back-to-back on the same model:
 *
 *  1. Natural EOS  — no `generationParams`, model stops on its own.
 *  2. Budget hit   — `predict: 10` forces truncation mid-output.
 *
 * The same `stopReason` is also available on the terminal `completionDone`
 * event in the `events` stream.
 */

import {
  completion,
  loadModel,
  unloadModel,
  QWEN3_600M_INST_Q4,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
    onProgress: (p) => console.log(`Loading: ${p.percentage.toFixed(1)}%`),
  });
  console.log(`✅ Model loaded: ${modelId}\n`);

  // --- Case 1: natural EOS ---
  console.log("=== Case 1: natural EOS (no predict limit) ===");
  const run1 = completion({
    modelId,
    history: [{ role: "user", content: "Say hi in one word." }],
    stream: true,
  });
  for await (const event of run1.events) {
    if (event.type === "contentDelta") process.stdout.write(event.text);
  }
  const final1 = await run1.final;
  console.log(`\nstopReason: ${final1.stopReason ?? "(undefined — natural EOS)"}`);

  // --- Case 2: predict budget exhausted → stopReason = "length" ---
  console.log("\n=== Case 2: predict budget hit (predict: 10) ===");
  const run2 = completion({
    modelId,
    history: [{ role: "user", content: "Count from 1 to 100, one number per line." }],
    generationParams: { predict: 10 },
    stream: true,
  });
  for await (const event of run2.events) {
    if (event.type === "contentDelta") process.stdout.write(event.text);
  }
  const final2 = await run2.final;
  console.log(`\nstopReason: ${final2.stopReason}`);

  await unloadModel({ modelId, clearStorage: false });
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
