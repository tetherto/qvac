/**
 * Multi-turn tool-calling example using the GPT-OSS model (Harmony dialect).
 *
 * GPT-OSS emits one tool call per generation, so multi-tool requests need
 * a turn-by-turn loop: send prompt + tools → mock-execute the returned
 * `ToolCall` → append the raw assistant frame + tool result to history →
 * repeat until the model produces a final answer (no tool call).
 *
 */
import {
  completion,
  loadModel,
  unloadModel,
  GPT_OSS_20B_INST_Q4_K_M,
} from "@qvac/sdk";
import { tools, mockExecute } from "./shared";

const MAX_TURNS = 5;

let modelId: string | undefined;
try {
  modelId = await loadModel({
    modelSrc: GPT_OSS_20B_INST_Q4_K_M,
    modelConfig: { ctx_size: 4096, tools: true },
    onProgress: (progress) =>
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`✅ Model loaded: ${modelId}`);

  const history: Array<{ role: string; content: string }> = [
    {
      role: "system",
      content:
        "You are a helpful assistant that can use tools to get the weather and horoscope.",
    },
    {
      role: "user",
      content: "What's the weather in Tokyo and my horoscope for Aquarius?",
    },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    console.log(`\n========== TURN ${turn} ==========`);
    const result = completion({ modelId, history, tools, stream: true });

    for await (const token of result.tokenStream) {
      process.stdout.write(token);
    }
    console.log();

    const final = await result.final;
    console.log(`\n--- TURN ${turn} SUMMARY ---`);
    console.log(`[sdk toolCalls] ${final.toolCalls.length}`);
    for (const call of final.toolCalls) {
      console.log(`  → ${call.name}(${JSON.stringify(call.arguments)})`);
    }

    if (final.toolCalls.length === 0) {
      console.log(`\n🎉 Final response received — exiting loop.`);
      break;
    }

    // Raw, not result.text — GPT-OSS needs its own framed output in history
    // to anchor the next turn.
    const assistantContent = final.raw.fullText;
    history.push({ role: "assistant", content: assistantContent });

    for (const call of final.toolCalls) {
      const toolResult = mockExecute(call.name, call.arguments);
      console.log(`  ✓ mock-executed ${call.name}: ${toolResult}`);
      history.push({ role: "tool", content: toolResult });
    }

    if (turn === MAX_TURNS) {
      console.log(`\n⚠️  MAX_TURNS (${MAX_TURNS}) reached — stopping.`);
    }
  }

  console.log(`\n========== HISTORY ==========`);
  for (const msg of history) {
    const preview = msg.content.slice(0, 120).replace(/\n/g, "\\n");
    console.log(
      `[${msg.role}] ${preview}${msg.content.length > 120 ? "…" : ""}`,
    );
  }
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
} finally {
  if (modelId) {
    try {
      await unloadModel({ modelId, clearStorage: false });
      console.log(`\n[unload] done`);
    } catch (unloadError) {
      console.error("[unload] failed:", unloadError);
    }
  }
}
