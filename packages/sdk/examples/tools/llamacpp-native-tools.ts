import {
  completion,
  loadModel,
  unloadModel,
  type ToolCall,
  type CompletionStats,
  QWEN3_1_7B_INST_Q4,
} from "@qvac/sdk";
import { tools, toolSchemas, mockExecute } from "./shared";

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
      tools: true,
    },
    onProgress: (progress) =>
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`✅ Model loaded successfully! Model ID: ${modelId}`);

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

  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token);
    }
  })();

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

  if (toolCalls.length > 0) {
    console.log("\n\n🔧 Simulating Tool Execution...");

    const toolResults = toolCalls.map((call) => {
      const result = mockExecute(call.name, call.arguments);
      console.log(`  ✓ ${call.name}: ${result}`);
      return { toolCallId: call.id, result };
    });

    history.push({
      role: "assistant",
      content: await result.text,
    });

    for (const toolResult of toolResults) {
      history.push({
        role: "tool",
        content: toolResult.result,
      });
    }

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
