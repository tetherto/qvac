/**
 * Cancel a specific in-flight completion by `requestId`.
 *
 * `completion(...)` exposes a stable `requestId` (UUIDv4, generated
 * client-side) on the returned `CompletionRun`. Pass it to
 * `cancel({ requestId })` to abort that exact run without affecting any
 * other inference happening on the same model.
 *
 * Two cancel paths exist:
 *
 *  1. `cancel({ requestId })` — targeted cancel, the primary path
 *     introduced in 0.11.0. The `requestId` is available synchronously
 *     on the `CompletionRun`, but the cancel only takes effect once the
 *     server has begun the request; a cancel issued in the same tick
 *     as `completion()` may arrive at the worker before the request is
 *     registered and is logged as a no-match.
 *  2. `cancel({ operation: "inference", modelId })` — broad cancel
 *     (escape hatch, kept indefinitely). Cancels every inference running
 *     on the model. Useful for unload, app shutdown, admin sweeps when
 *     the caller doesn't have a `requestId` to hand.
 */

import {
  cancel,
  completion,
  loadModel,
  unloadModel,
  QWEN3_600M_INST_Q4,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelType: "llm",
    modelConfig: { ctx_size: 4096 },
  });

  const run = completion({
    modelId,
    history: [
      {
        role: "user",
        content:
          "Write a long, detailed essay about the history of the Roman Empire.",
      },
    ],
    stream: true,
  });

  console.log(`requestId: ${run.requestId}`);

  // Cancel after a short delay so we exercise the cancel-mid-decode path.
  setTimeout(() => {
    void cancel({ requestId: run.requestId });
    console.log("(cancel issued)");
  }, 250);

  let tokenCount = 0;
  for await (const event of run.events) {
    if (event.type === "contentDelta") {
      tokenCount++;
      process.stdout.write(event.text);
    }
  }
  console.log(`\n\nstreamed ${tokenCount} content deltas before cancel.`);

  await unloadModel({ modelId });
  process.exit(0);
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
