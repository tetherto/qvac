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
 *     on the `CompletionRun`. Same-tick cancels (issued before the
 *     server has registered the request) are recorded and applied
 *     retroactively when `begin(...)` arrives, so they aren't silently
 *     dropped.
 *  2. `cancel({ operation: "inference", modelId })` — broad cancel
 *     (escape hatch, kept indefinitely). Cancels every inference running
 *     on the model. Useful for unload, app shutdown, admin sweeps when
 *     the caller doesn't have a `requestId` to hand.
 *
 * --- Cancel outcomes (0.11.0+) ---
 *
 * A cancel surfaces on two channels:
 *
 *  - `run.events` ends *normally* with a `completionDone` event carrying
 *    `stopReason: "cancelled"`. The loop exits cleanly, no thrown error.
 *  - `run.text` / `run.final` / `run.stats` / `run.toolCalls` reject
 *    with `InferenceCancelledError(requestId, partial)`, where `partial`
 *    holds whatever the model produced before the cancel landed
 *    (accumulated `text`, completed `toolCalls`, last-known `stats`).
 *
 * Pick the channel that matches how you consume the run: event-loop
 * consumers don't need to catch anything; promise-aggregate consumers
 * pattern-match on `instanceof InferenceCancelledError`.
 */

import {
  cancel,
  completion,
  loadModel,
  unloadModel,
  InferenceCancelledError,
  QWEN3_600M_INST_Q4,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
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

  console.log(`▸ requestId: ${run.requestId}`);

  // Cancel after a short delay so we exercise the cancel-mid-decode path.
  setTimeout(() => {
    void cancel({ requestId: run.requestId });
    console.log("▸ cancel issued");
  }, 250);

  // Channel 1: the events stream ends normally on cancel. The
  // `completionDone` event's `stopReason` tells you why the loop is
  // about to exit ("eos" | "length" | "cancelled" | "error" | ...).
  let tokenCount = 0;
  let endReason: string | undefined;
  for await (const event of run.events) {
    if (event.type === "contentDelta") {
      tokenCount++;
      process.stdout.write(event.text);
    } else if (event.type === "completionDone") {
      endReason = event.stopReason;
    }
  }
  console.log(
    `\n\n▸ streamed ${tokenCount} content deltas, stopReason=${endReason}`,
  );

  // Channel 2: promise-aggregates reject with InferenceCancelledError
  // on cancel. The accumulated state up to the cancel point is preserved
  // on `err.partial`.
  try {
    const text = await run.text;
    console.log(`▸ completed normally (${text.length} chars)`);
  } catch (err) {
    if (err instanceof InferenceCancelledError) {
      console.log(`▸ run.text rejected: cancelled (requestId=${err.requestId})`);
      console.log(`▸ partial text length: ${(err.partial.text ?? "").length}`);
      if (err.partial.stats?.tokensPerSecond !== undefined) {
        console.log(
          `▸ partial stats: ${err.partial.stats.tokensPerSecond.toFixed(1)} tok/s`,
        );
      }
      if (err.partial.toolCalls && err.partial.toolCalls.length > 0) {
        console.log(`▸ partial tool calls: ${err.partial.toolCalls.length}`);
      }
    } else {
      throw err;
    }
  }

  await unloadModel({ modelId });
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
