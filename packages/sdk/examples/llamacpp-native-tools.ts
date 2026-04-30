import { z } from "zod";
import {
  completion,
  loadModel,
  unloadModel,
  type ToolCall,
  type CompletionStats,
  QWEN3_1_7B_INST_Q4,
} from "@/index";

// Define Zod schemas for tool parameters
const weatherSchema = z.object({
  city: z.string().describe("City name"),
  country: z.string().describe("Country code").optional(),
});

const horoscopeSchema = z.object({
  sign: z.string().describe("An astrological sign like Taurus or Aquarius"),
});

// Map tool names to their schemas for runtime validation
const toolSchemas = {
  get_weather: weatherSchema,
  get_horoscope: horoscopeSchema,
};

// Simple tool definitions - just name, description, and Zod schema!
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
  // Load model from provided file path with tools support enabled
  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
      tools: true, // Enable tools support
    },
    onProgress: (progress) =>
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`✅ Model loaded successfully! Model ID: ${modelId}`);

  // Create conversation history
  const history = [
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

  console.log("\n🤖 AI Response:");
  console.log("(Streaming with tool definitions in prompt)\n");

  const result = completion({ modelId, history, stream: true, tools });

  // Consume token stream
  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token);
    }
  })();

  // Consume tool call events
  const toolsTask = (async () => {
    for await (const evt of result.toolCallStream) {
      console.log(
        `\n\n→ Tool Call Detected: ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`,
      );
      console.log(`   ID: ${evt.call.id}`);
    }
  })();

  await Promise.all([tokensTask, toolsTask]);

  const stats: CompletionStats | undefined = await result.stats;
  const toolCalls: ToolCall[] = await result.toolCalls;

  console.log("\n\n📋 Parsed Tool Calls:");
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      console.log(`  - ${call.name}(${JSON.stringify(call.arguments)})`);

      const schema = toolSchemas[call.name as keyof typeof toolSchemas];
      if (schema) {
        const validated = schema.safeParse(call.arguments);
        if (validated.success) {
          console.log(`    ✓ Arguments validated with Zod`);
        } else {
          console.log(`    ✗ Validation failed:`, validated.error);
        }
      }
    }
  } else {
    console.log("  No tool calls detected in response");
  }

  console.log("\n📊 Performance Stats:", stats);

  // Execute tool calls and send results back to the model
  if (toolCalls.length > 0) {
    console.log("\n\n🔧 Simulating Tool Execution...");

    // Simulate tool execution (in a real app, you'd call actual APIs)
    const toolResults = toolCalls.map((call) => {
      let result = "";
      if (call.name === "get_weather") {
        const args = call.arguments as { city: string; country?: string };
        result = `The weather in ${args.city} is sunny, 22°C with light clouds.`;
      } else if (call.name === "get_horoscope") {
        const args = call.arguments as { sign: string };
        result = `Horoscope for ${args.sign}: Today is a great day for new beginnings and creative endeavors!`;
      }
      console.log(`  ✓ ${call.name}: ${result}`);
      return { toolCallId: call.id, result };
    });

    // Add tool results to conversation history
    history.push({
      role: "assistant",
      content: await result.text,
    });

    // Add tool results as tool messages
    for (const toolResult of toolResults) {
      history.push({
        role: "tool",
        content: toolResult.result,
      });
    }

    // Send follow-up question with tool results
    console.log("\n\n🤖 Follow-up Response with Tool Results:");
    const followUpResult = completion({
      modelId,
      history,
      stream: true,
      tools,
    });

    for await (const token of followUpResult.tokenStream) {
      process.stdout.write(token);
    }

    const followUpStats = await followUpResult.stats;
    console.log("\n\n📊 Follow-up Stats:", followUpStats);
  }

  console.log("\n\n🎉 Completed!");
  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
