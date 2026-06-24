/**
 * Demonstrates how `qvac serve` handles a coding agent firing two completions
 * at the SAME loaded model at once (e.g. a chat completion plus a
 * title/summary call) — the workload that used to break it.
 *
 * Background: a loaded llama.cpp model is one native context (one KV-cache,
 * one decode loop), so two completions on it cannot truly run in parallel.
 * The SDK worker installs a per-`(kind, modelId)` FIFO admission queue for
 * the `completion` kind (`maxConcurrentPerModel: 1`, `onOverflow: "queue"`).
 * A second concurrent completion on the same model now WAITS its turn and
 * then runs, instead of being rejected with `RequestRejectedByPolicyError`
 * (code 52420) or colliding at the addon with "Cannot set new job".
 *
 * Part 1 — two concurrent completions on the SAME model  → both succeed,
 *          serialized by the queue (the bug this fixes: previously one was
 *          rejected/collided).
 * Part 2 — two concurrent completions on DIFFERENT models → both succeed and
 *          run in parallel (the queue is keyed per `(kind, modelId)`, so
 *          distinct models never block each other).
 *
 * Run from packages/sdk:
 *   bun run examples/concurrent-completion-collision.ts
 */
import {
  completion,
  loadModel,
  unloadModel,
  QWEN3_1_7B_INST_Q4,
  LLAMA_3_2_1B_INST_Q4_0,
  RequestRejectedByPolicyError,
} from "@qvac/sdk";

type Outcome =
  | { label: string; ok: true; text: string }
  | { label: string; ok: false; errorName: string; code?: number; message: string };

async function runCompletion(
  label: string,
  modelId: string,
  prompt: string,
): Promise<Outcome> {
  try {
    // `completion()` starts the request synchronously, so calling this for two
    // tasks in the same tick puts both "in flight" before either is awaited.
    const result = completion({
      modelId,
      history: [{ role: "user", content: prompt }],
      stream: false,
    });
    const text = await result.text;
    return { label, ok: true, text };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: number }).code
        : undefined;
    const base = {
      label,
      ok: false as const,
      errorName: error instanceof Error ? error.constructor.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
    return code !== undefined ? { ...base, code } : base;
  }
}

function report(title: string, outcomes: Outcome[]): void {
  console.log(`\n▸ ${title}`);
  for (const o of outcomes) {
    if (o.ok) {
      const preview = o.text.replace(/\s+/g, " ").slice(0, 70);
      console.log(`  ▸ ${o.label}: ${preview}${o.text.length > 70 ? "…" : ""}`);
    } else {
      const policy = o.code === 52420 ? " (rejected by policy)" : "";
      console.log(
        `  ✖ ${o.label}: ${o.errorName}${o.code !== undefined ? ` [${o.code}]` : ""}${policy} — ${o.message}`,
      );
    }
  }
}

try {
  const modelA = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelConfig: { ctx_size: 4096 },
  });

  // Part 1 — same model, two concurrent completions.
  const sameModel = await Promise.all([
    runCompletion("req-A1", modelA, "What is Bitcoin? One sentence."),
    runCompletion("req-A2", modelA, "What is a hash function? One sentence."),
  ]);
  report(
    "Part 1 — two concurrent completions on the SAME model (expect both to succeed, serialized):",
    sameModel,
  );

  const rejected = sameModel.filter((o) => !o.ok).length;
  if (rejected === 0) {
    console.log(
      "  ▸ Both succeeded: the second was queued behind the first and ran when the slot freed (no 52420, no addon collision).",
    );
  } else {
    console.log(
      `  ▸ ${rejected}/2 failed — the FIFO admission queue should have serialized these. Check the completion policy.`,
    );
  }

  // Part 2 — different models, two concurrent completions (the "parallel that works").
  const modelB = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { ctx_size: 4096 },
  });
  const differentModels = await Promise.all([
    runCompletion("req-A", modelA, "Name one use of Bitcoin. One sentence."),
    runCompletion("req-B", modelB, "Name one use of Ethereum. One sentence."),
  ]);
  report(
    "Part 2 — two concurrent completions on DIFFERENT models (expect both succeed):",
    differentModels,
  );

  await unloadModel({ modelId: modelA, clearStorage: false });
  await unloadModel({ modelId: modelB, clearStorage: false });

  console.log(
    `\n▸ rejected-by-policy error available for instanceof checks: ${typeof RequestRejectedByPolicyError === "function"}`,
  );
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
