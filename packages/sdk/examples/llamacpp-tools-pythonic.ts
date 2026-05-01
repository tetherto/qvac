import { z } from "zod";
import {
  completion,
  loadModel,
  unloadModel,
  type ToolCall,
} from "@qvac/sdk";

// LFM2-1.2B-Tool emits Pythonic-style calls: [get_weather(city="Tokyo")].
const LFM_TOOL_HF =
  "https://huggingface.co/LiquidAI/LFM2-1.2B-Tool-GGUF/resolve/main/LFM2-1.2B-Tool-Q4_K_M.gguf";

const weatherSchema = z.object({
  city: z.string().describe("City name"),
});

const horoscopeSchema = z.object({
  sign: z.string().describe("An astrological sign like Taurus or Aquarius"),
});

const tools = [
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

try {
  const modelId = await loadModel({
    modelSrc: LFM_TOOL_HF,
    modelType: "llm",
    modelConfig: { ctx_size: 4096, tools: true },
    onProgress: (progress) =>
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`✅ Model loaded: ${modelId}`);

  const history = [
    {
      role: "system",
      content:
        "You are a helpful assistant that can call tools to look up weather and horoscopes.",
    },
    {
      role: "user",
      content: "What's the weather in Tokyo and my horoscope for Aquarius?",
    },
  ];

  console.log("\n🤖 Streaming...\n");

  const result = completion({ modelId, history, stream: true, tools });

  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token);
    }
  })();

  const toolsTask = (async () => {
    for await (const evt of result.toolCallStream) {
      console.log(
        `\n→ ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`,
      );
    }
  })();

  await Promise.all([tokensTask, toolsTask]);

  const toolCalls: ToolCall[] = await result.toolCalls;

  console.log("\n\n📋 Final tool calls:");
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      console.log(`  - ${call.name}(${JSON.stringify(call.arguments)})`);
    }
  } else {
    console.log("  (none)");
  }

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
