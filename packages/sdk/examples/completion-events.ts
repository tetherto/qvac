/**
 * Event-driven completion — demonstrates the unified `CompletionEvent` stream.
 *
 * `completion()` returns a `CompletionRun` with two primary surfaces:
 *
 *  - `events`  — an `AsyncIterable<CompletionEvent>` of ordered, typed events
 *                (`contentDelta`, `thinkingDelta`, `toolCall`, `toolError`,
 *                 `completionStats`, `completionDone`, `rawDelta`).
 *  - `final`   — a `Promise<CompletionFinal>` that resolves once the stream
 *                ends, providing aggregated `contentText`, `thinkingText`,
 *                `toolCalls`, `stats`, and `raw.fullText`.
 *
 * Set `captureThinking: true` to attempt best-effort `<think>` block parsing
 * into dedicated `thinkingDelta` events. `final.raw.fullText` keeps the exact
 * model output.
 */

import {
  completion,
  loadModel,
  unloadModel,
  QWEN3_600M_INST_Q4,
  type CompletionEvent,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelType: "llm",
    modelConfig: { ctx_size: 4096 },
    onProgress: (p) => console.log(`Loading: ${p.percentage.toFixed(1)}%`),
  });
  console.log(`✅ Model loaded: ${modelId}\n`);

  const result = completion({
    modelId,
    history: [{ role: "user", content: "Explain quantum computing in 2 sentences" }],
    stream: true,
    captureThinking: true,
  });

  for await (const event of result.events) {
    handleEvent(event);
  }

  const final = await result.final;

  console.log("\n\n--- Final Result ---");
  console.log(`Content: ${final.contentText}\n`);
  if (final.thinkingText) {
    console.log(`Thinking: ${final.thinkingText}\n`);
  }
  if (final.stats) {
    console.log(`Stats: ${final.stats.tokensPerSecond?.toFixed(1)} tok/s`);
  }
  if (final.toolCalls.length > 0) {
    console.log(`Tool calls: ${final.toolCalls.map((c) => c.name).join(", ")}`);
  }
  console.log(`Raw output length: ${final.raw.fullText.length} chars`);

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}

function handleEvent(event: CompletionEvent) {
  switch (event.type) {
    case "contentDelta":
      process.stdout.write(event.text);
      break;
    case "thinkingDelta":
      process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
      break;
    case "toolCall":
      console.log(`\n→ Tool: ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
      break;
    case "toolError":
      console.warn(`\n⚠ Tool error [${event.error.code}]: ${event.error.message}`);
      break;
    case "completionStats":
      console.log(`\n📊 ${event.stats.tokensPerSecond?.toFixed(1)} tok/s`);
      break;
    case "completionDone":
      if (event.stopReason === "error" && "error" in event) {
        console.error(`\n❌ ${event.error.message}`);
      }
      break;
    case "rawDelta":
      break;
  }
}
