/**
 * Dynamic-tools mode example.
 *
 * In `dynamic` mode each user prompt can carry its own tool set: the addon
 * anchors tools after the last user message, runs the tool-call chain, then
 * trims the tools + chain output from the kv-cache so a later turn can ship
 * a different tool list without poisoning the cache. Compare with
 * `llamacpp-native-tools.ts`, which uses the default `static` mode where
 * one shared tool set lives at the top of the session.
 *
 * Run with:
 *   bun run build
 *   bun run bare:example dist/examples/llamacpp-dynamic-tools.js
 */
import { z } from "zod";
import {
  completion,
  loadModel,
  unloadModel,
  type ToolCall,
  type CompletionParams,
  type ToolInput,
  QWEN3_1_7B_INST_Q4,
} from "@qvac/sdk";

const weatherSchema = z.object({
  city: z.string().describe("City name"),
});

const horoscopeSchema = z.object({
  sign: z.string().describe("An astrological sign, e.g. Taurus or Aquarius"),
});

const dateSchema = z.object({});

const toolSchemas = {
  get_weather: weatherSchema,
  get_horoscope: horoscopeSchema,
  get_date: dateSchema,
} as const;

const weatherTools: ToolInput[] = [
  {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: weatherSchema,
  },
];

const horoscopeTools: ToolInput[] = [
  {
    name: "get_horoscope",
    description: "Get today's horoscope for an astrological sign",
    parameters: horoscopeSchema,
  },
];

const dateTools: ToolInput[] = [
  {
    name: "get_date",
    description: "Get today's date",
    parameters: dateSchema,
  },
];

function executeToolCall(call: ToolCall): string {
  if (call.name === "get_weather") {
    const args = call.arguments as { city: string };
    return `The weather in ${args.city} is rainy, 8°C with heavy clouds.`;
  }
  if (call.name === "get_horoscope") {
    const args = call.arguments as { sign: string };
    return `Horoscope for ${args.sign}: a great day for new beginnings.`;
  }
  if (call.name === "get_date") {
    return new Date().toISOString().slice(0, 10);
  }
  return `Unknown tool: ${call.name}`;
}

type ChatTurnParams = Pick<CompletionParams, "modelId" | "kvCache"> & {
  history: Array<{ role: string; content: string }>;
  tools: ToolInput[];
};

async function chatTurn({ modelId, kvCache, history, tools }: ChatTurnParams) {
  const result = completion({
    modelId,
    history,
    tools,
    kvCache,
    stream: true,
  });

  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token);
    }
  })();

  const toolEventsTask = (async () => {
    for await (const evt of result.toolCallStream) {
      console.log(
        `\n→ tool call: ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`,
      );
    }
  })();

  await Promise.all([tokensTask, toolEventsTask]);

  const text = await result.text;
  const toolCalls: ToolCall[] = await result.toolCalls;

  if (toolCalls.length === 0) {
    history.push({ role: "assistant", content: text });
    return;
  }

  for (const call of toolCalls) {
    const schema = toolSchemas[call.name as keyof typeof toolSchemas];
    if (schema) {
      const parsed = schema.safeParse(call.arguments);
      if (!parsed.success) {
        console.warn(`   ✗ validation failed for ${call.name}:`, parsed.error);
      }
    }
  }

  history.push({ role: "assistant", content: text });
  for (const call of toolCalls) {
    history.push({ role: "tool", content: executeToolCall(call) });
  }

  // Follow-up turn so the model can incorporate the tool results.
  await chatTurn({ modelId, kvCache, history, tools });
}

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
      tools: true,
      toolsMode: "dynamic",
    },
    onProgress: (progress) =>
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`✅ Model loaded: ${modelId}`);

  const kvCache = `dynamic-tools-${Date.now()}`;
  const history: Array<{ role: string; content: string }> = [
    {
      role: "system",
      content:
        "You are a helpful assistant that uses tools when they are available. " +
        "User's cat is named Windy and dog is named Butch.",
    },
  ];

  // Turn 1 — only weather tools available.
  history.push({ role: "user", content: "What's the weather in Tokyo?" });
  console.log("\n🤖 Turn 1 (tools=weather):\n");
  await chatTurn({ modelId, kvCache, history, tools: weatherTools });

  // Turn 2 — same session, swap to horoscope tools. Dynamic mode lets the
  // model see a different tool set without invalidating the kv-cache.
  history.push({ role: "user", content: "Now check my horoscope for Aquarius." });
  console.log("\n\n🤖 Turn 2 (tools=horoscope):\n");
  await chatTurn({ modelId, kvCache, history, tools: horoscopeTools });

  // Turn 3 — swap to a parameterless tool to confirm empty-arg flows work.
  history.push({ role: "user", content: "What's today's date?" });
  console.log("\n\n🤖 Turn 3 (tools=date):\n");
  await chatTurn({ modelId, kvCache, history, tools: dateTools });

  console.log("\n\n🎉 Done.");
  await unloadModel({ modelId, clearStorage: false });
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
