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
    modelConfig: { ctx_size: 4096 },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ Model loaded: ${modelId}`);

  const result = completion({
    modelId,
    history: [
      { role: "user", content: "Explain quantum computing in 2 sentences" },
    ],
    stream: true,
    captureThinking: true,
  });

  for await (const event of result.events) {
    handleEvent(event);
  }

  const final = await result.final;

  console.log("\n▸ Final result");
  console.log(`▸ Content: ${final.contentText}`);
  if (final.thinkingText) {
    console.log(`▸ Thinking: ${final.thinkingText}`);
  }
  if (final.stats) {
    console.log(`▸ ${final.stats.tokensPerSecond?.toFixed(1)} tok/s`);
  }
  if (final.toolCalls.length > 0) {
    console.log(`▸ Tool calls: ${final.toolCalls.map((c) => c.name).join(", ")}`);
  }
  if (final.stopReason) {
    console.log(`▸ Stop reason: ${final.stopReason}`);
  }
  console.log(`▸ Raw output length: ${final.raw.fullText.length} chars`);

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("✖", error);
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
      console.log(
        `\n▸ Tool: ${event.call.name}(${JSON.stringify(event.call.arguments)})`,
      );
      break;
    case "toolError":
      console.log(
        `\n✖ Tool error [${event.error.code}]: ${event.error.message}`,
      );
      break;
    case "completionStats":
      console.log(`\n▸ ${event.stats.tokensPerSecond?.toFixed(1)} tok/s`);
      break;
    case "completionDone":
      if (event.stopReason === "error" && "error" in event) {
        console.log(`\n✖ ${event.error.message}`);
      }
      break;
    case "rawDelta":
      break;
  }
}
