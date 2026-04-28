/**
 * Smoke script for native tool-call format support. Loads a model with
 * `tools: true`, sends a fixed prompt with two tool definitions, and dumps
 * the raw assistant stream so we can see literal markers like `<|channel|>`
 * or `<|tool_call_start|>` if the model emits them.
 *
 * Usage (run from packages/sdk):
 *   bun run scripts/smoke-native-tool-formats.ts llama-tool-calling
 *   bun run scripts/smoke-native-tool-formats.ts lfm-tool
 *   bun run scripts/smoke-native-tool-formats.ts gpt-oss-20b
 *   bun run scripts/smoke-native-tool-formats.ts qwen3-1.7b
 *   bun run scripts/smoke-native-tool-formats.ts custom \
 *     --src=https://huggingface.co/<owner>/<repo>/resolve/main/<file>.gguf \
 *     --dialect=pythonic
 */

import { z } from "zod";
import {
  completion,
  loadModel,
  unloadModel,
  GPT_OSS_20B_INST_Q4_K_M,
  LLAMA_TOOL_CALLING_1B_INST_Q4_K,
  QWEN3_1_7B_INST_Q4,
} from "@/index";
import type { ModelSrcInput } from "@/schemas";

type Dialect = "harmony" | "pythonic" | "hermes" | "json";

type SmokeTarget = {
  modelSrc: ModelSrcInput;
  expectedDialect: Dialect;
  label: string;
};

const TARGETS: Record<string, SmokeTarget> = {
  "llama-tool-calling": {
    modelSrc: LLAMA_TOOL_CALLING_1B_INST_Q4_K,
    expectedDialect: "pythonic",
    label: "Llama 3.2 1B Tool Calling V2 (Q4_K) — registry",
  },
  "lfm-tool": {
    modelSrc:
      "https://huggingface.co/LiquidAI/LFM2-1.2B-Tool-GGUF/resolve/main/LFM2-1.2B-Tool-Q4_K_M.gguf",
    expectedDialect: "pythonic",
    label: "LiquidAI LFM2-1.2B-Tool (Q4_K_M) — direct HF download",
  },
  "gpt-oss-20b": {
    modelSrc: GPT_OSS_20B_INST_Q4_K_M,
    expectedDialect: "harmony",
    label: "GPT-OSS 20B (Q4_K_M) — registry",
  },
  // Qwen3 baseline for the EOG-suppression comparison. Emits Hermes-style
  // <tool_call>...</tool_call> blocks.
  "qwen3-1.7b": {
    modelSrc: QWEN3_1_7B_INST_Q4,
    expectedDialect: "hermes",
    label: "Qwen3 1.7B Instruct (Q4_0) — registry",
  },
};

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const singleTool = hasFlag("single-tool");

const targetKey = process.argv[2];
let target: SmokeTarget | undefined;

if (targetKey === "custom") {
  const src = parseFlag("src");
  const dialectFlag = parseFlag("dialect");
  if (!src || (dialectFlag !== "harmony" && dialectFlag !== "pythonic")) {
    console.error(
      "Usage: bun run scripts/smoke-native-tool-formats.ts custom --src=<url-or-path> --dialect=<harmony|pythonic>",
    );
    process.exit(2);
  }
  target = {
    modelSrc: src,
    expectedDialect: dialectFlag,
    label: `custom — ${src}`,
  };
} else if (targetKey && TARGETS[targetKey]) {
  target = TARGETS[targetKey];
}

if (!target) {
  console.error(
    `Usage: bun run scripts/smoke-native-tool-formats.ts <${Object.keys(TARGETS).join(" | ")} | custom --src=... --dialect=...> [--single-tool]`,
  );
  process.exit(2);
}

const weatherSchema = z.object({
  city: z.string().describe("City name"),
  country: z.string().describe("Country code").optional(),
});

const horoscopeSchema = z.object({
  sign: z.string().describe("An astrological sign like Taurus or Aquarius"),
});

const allTools = [
  {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: weatherSchema,
  },
  {
    name: "get_horoscope",
    description: "Get today's horoscope for an astrological sign",
    parameters: horoscopeSchema,
  },
];

const tools = singleTool ? [allTools[0]!] : allTools;

const history = singleTool
  ? [
      {
        role: "system",
        content:
          "You are a helpful assistant that can use the get_weather tool.",
      },
      { role: "user", content: "What's the weather in Tokyo?" },
    ]
  : [
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

const srcDescription =
  typeof target.modelSrc === "string"
    ? target.modelSrc
    : (target.modelSrc.name ?? target.modelSrc.src);

console.log(`\n===== SMOKE TARGET =====`);
console.log(`label:            ${target.label}`);
console.log(`expectedDialect:  ${target.expectedDialect}`);
console.log(`modelSrc:         ${srcDescription}`);
console.log(`mode:             ${singleTool ? "single-tool" : "multi-tool"}`);
console.log(`tools:            ${tools.map((t) => t.name).join(", ")}`);
console.log(`========================\n`);

// Bare worker stdio is inherited from the parent, so addon / llama.cpp lines
// bypass JS-level process.stdout.write hooks. To see load-time
// `... logit bias = -inf` lines, tee the run output and grep that file.
const capturedLogLines: string[] = [];

let modelId: string | undefined;
try {
  modelId = await loadModel({
    modelSrc: target.modelSrc,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
      tools: true,
      verbosity: 3,
    },
    onProgress: (progress) =>
      console.log(`[load] ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`[load] done — modelId=${modelId}\n`);

  const logitBiasHits = capturedLogLines.filter((line) =>
    line.includes("logit bias"),
  );
  console.log(`===== LOAD-TIME LOGIT-BIAS LINES (JS-captured) =====`);
  console.log(`count: ${logitBiasHits.length}`);
  console.log(
    "  (Note: addon stderr is inherited at the OS level; lines emitted",
  );
  console.log(
    "   directly by llama.cpp bypass JS hooks. Grep the run log file",
  );
  console.log("   for `logit bias` to see them.)");
  for (const line of logitBiasHits) console.log(`  ${line}`);
  console.log(`===== END LOAD-TIME LOGIT-BIAS LINES =====\n`);

  const result = completion({ modelId, history, stream: true, tools });

  let rawAccumulated = "";

  console.log(`===== EVENT STREAM SUMMARY =====`);
  let stopReason: string | undefined;
  let eventCount = 0;
  let contentLen = 0;
  let rawLen = 0;
  for await (const event of result.events) {
    eventCount += 1;
    switch (event.type) {
      case "contentDelta":
        contentLen += event.text.length;
        rawAccumulated += event.text;
        break;
      case "rawDelta":
        rawLen += event.text.length;
        break;
      case "thinkingDelta":
        break;
      case "toolCall":
        console.log(
          `  [event toolCall] ${event.call.name}(${JSON.stringify(event.call.arguments)})`,
        );
        break;
      case "toolError":
        console.log(`  [event toolError] ${JSON.stringify(event.error)}`);
        break;
      case "completionStats":
        break;
      case "completionDone":
        stopReason = event.stopReason;
        if (event.stopReason === "error") {
          console.log(`  [event done error] ${event.error.message}`);
        }
        break;
    }
  }
  console.log(`  events: ${eventCount}`);
  console.log(`  contentDelta total chars: ${contentLen}`);
  console.log(`  rawDelta total chars:     ${rawLen}`);
  console.log(`  stopReason:               ${stopReason ?? "<unknown>"}`);
  console.log(`===== END EVENT STREAM SUMMARY =====\n`);

  console.log(`===== RAW ACCUMULATED TEXT =====`);
  console.log(rawAccumulated);
  console.log(`===== END RAW ACCUMULATED TEXT =====\n`);

  console.log(`===== RAW ACCUMULATED TAIL (last 200 chars) =====`);
  console.log(JSON.stringify(rawAccumulated.slice(-200)));
  console.log(`===== END RAW ACCUMULATED TAIL =====\n`);

  const final = await result.final;
  const toolCalls = final.toolCalls;
  console.log(`===== SDK-PARSED TOOL CALLS =====`);
  console.log(`length: ${toolCalls.length}`);
  for (const call of toolCalls) {
    console.log(`  - ${call.name}(${JSON.stringify(call.arguments)})`);
  }
  console.log(`===== END SDK-PARSED TOOL CALLS =====\n`);

  console.log(`[raw.fullText.length] ${final.raw.fullText.length}`);
  console.log(`[raw.toolDialect]     ${final.raw.toolDialect ?? "<none>"}`);
  console.log(`===== RAW FULL TEXT (model output, post-detokenize) =====`);
  console.log(final.raw.fullText);
  console.log(`===== END RAW FULL TEXT =====\n`);

  console.log(`===== RAW FULL TEXT TAIL (last 200 chars) =====`);
  console.log(JSON.stringify(final.raw.fullText.slice(-200)));
  console.log(`===== END RAW FULL TEXT TAIL =====\n`);

  console.log(`[stats] ${JSON.stringify(final.stats)}`);
} catch (error) {
  console.error("[smoke] error:", error);
  process.exitCode = 1;
} finally {
  if (modelId) {
    try {
      await unloadModel({ modelId, clearStorage: false });
      console.log(`[unload] done`);
    } catch (unloadError) {
      console.error("[unload] failed:", unloadError);
    }
  }
}
