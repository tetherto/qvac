import { z } from "zod";
import {
  completion,
  loadModel,
  unloadModel,
  type ToolInput,
  type ToolCall,
  type CompletionStats,
  type CompletionParams,
  QWEN3_1_7B_INST_Q4,
} from "@qvac/sdk";

// Define Zod schemas for tool parameters
const weatherSchema = z.object({
  city: z.string().describe("City name"),
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
const tools1 = [
  {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: weatherSchema,
  },
];

const tools2 = [
  {
    name: "get_horoscope",
    description: "Get today's horoscope for an astrological sign",
    parameters: horoscopeSchema,
  },
];

const tools3 = [
  {
    name: "get_date",
    description: "Get today's Date",
    parameters: z.object(),
  },
];

type ChatSesssionParam = CompletionParams & {
  tools: ToolInput[]
}
async function chatSession ({ modelId, history, tools, kvCache }: ChatSesssionParam) {
  const result = completion({ modelId, history, kvCache, stream: true, tools });

  // Consume token stream
  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token);
    }
  })();

  // Consume tool call events
  const toolsTask = (async () => {
    for await (const evt of result.toolCallStream) {
      if (evt.type === "toolCall") {
        console.log(
          `\n\n→ Tool Call Detected: ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`,
        );
        console.log(`   ID: ${evt.call.id}`);
      } else if (evt.type === "toolCallError") {
        console.warn(`\n⚠️  Tool Error: ${evt.error.message}`);
        console.warn(`   Code: ${evt.error.code}`);
      }
    }
  })();

  await Promise.all([tokensTask, toolsTask]);

  const stats: CompletionStats | undefined = await result.stats;
  const toolCalls: ToolCall[] = await result.toolCalls;

  if (toolCalls.length > 0) {
    console.log("\n\n📋 Parsed Tool Calls:");
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
    history.push({
      role: "assistant",
      content: await result.text,
    });
    console.log("\n📊 <NO TOOL CALLS FOUND> Performance Stats:", stats);
    return;
  }

  console.log("\n📊 <WITH TOOLS> Performance Stats:", stats);

  // Execute tool calls and send results back to the model
  if (toolCalls.length > 0) {
    console.log("\n\n🔧 Simulating Tool Execution...");

    // Simulate tool execution (in a real app, you'd call actual APIs)
    const toolResults = toolCalls.map((call) => {
      let result = "";
      if (call.name === "get_weather") {
        const args = call.arguments as { city: string; country?: string };
        result = `The weather in ${args.city} is rainy, 08°C with heavy clouds.`;
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
  }

  // Send follow-up question with tool results
  console.log("\n\n🤖 Follow-up Response with Tool Results:");
  const followUpResult = completion({
    modelId,
    history,
    stream: true,
    kvCache,
    tools,
  });

  for await (const token of followUpResult.tokenStream) {
    process.stdout.write(token);
  }

  history.push({
    role: "assistant",
    content: await followUpResult.text,
  });

  const followUpStats = await followUpResult.stats;
  console.log("\n\n📊 Follow-up Stats:", followUpStats);
}

type ToolInvocationParam = Pick<CompletionParams, 'kvCache'> & {
  toolVariants: [ToolInput[], ToolInput[], ToolInput[]]
}
export async function runToolInvocationTest({ kvCache, toolVariants }: ToolInvocationParam) {
  try {
    // Load model from provided file path with tools support enabled
    const modelId = await loadModel({
      modelSrc: QWEN3_1_7B_INST_Q4,
      modelType: "llm",
      modelConfig: {
        ctx_size: 4096,
        tools: true, // Enable tools support
        toolsMode: 'dynamic',
      },
      onProgress: (progress) =>
        console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
    });
    console.log(`✅ Model loaded successfully! Model ID: ${modelId}`);

    // Create conversation history
    const history = [
      {
        role: "system",
        content:"You are a helpful assistant that can use tools. User's cat name is Windy and dog is Butch",
      },
      {
        role: "user",
        content: "What's the weather in Tokyo?",
      },
    ];

    console.log("\n🤖 AI Response:");
    console.log("(Streaming with tool definitions in prompt)\n");

    await chatSession({ modelId, history, tools: toolVariants[0], kvCache })

    history.push({
      role: "user",
      content: "What is my cat name?",
    })

    console.log("\n🤖 AI Response:");
    await chatSession({ modelId, history, tools: toolVariants[0], kvCache })

    history.push({
      role: "user",
      content: "What's my dog name?",
    })

    console.log("\n🤖 AI Response:");
    await chatSession({ modelId, history, tools: toolVariants[0], kvCache })

    history.push({
      role: "user",
      content: "What is the weather in Tokyo?",
    })
    console.log("\n🤖 AI Response:");
    await chatSession({ modelId, history, tools: toolVariants[2], kvCache })

    history.push({
      role: "user",
      content: "only in case the weather in Tokyo is rainy, check my horoscope for Aquarius; if the weather is good - check Taurus; need only one horoscope depending on the whether",
    })

    console.log("\n🤖 AI Response:");
    console.log("(Streaming with tool definitions in prompt)\n");

    await chatSession({ modelId, history, tools: toolVariants[1], kvCache })

    console.log("\n\n🎉 Completed!");
    await unloadModel({ modelId, clearStorage: false });
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

export async function runToolInvocationContTest({ kvCache, toolVariants }: ToolInvocationParam) {
  try {
    // Load model from provided file path with tools support enabled
    const modelId = await loadModel({
      modelSrc: QWEN3_1_7B_INST_Q4,
      modelType: "llm",
      modelConfig: {
        ctx_size: 4096,
        tools: true, // Enable tools support
        toolsMode: 'dynamic',
      },
      onProgress: (progress) =>
        console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
    });
    console.log(`✅ Model loaded successfully! Model ID: ${modelId}`);

    // Create conversation history
    const history = [
      {
        role: "system",
        content:"You are a helpful assistant that can use tools. User's cat name is Windy and dog is Butch",
      },
      {
        role: "user",
        content: "What's the weather in Tokyo?",
      },
      {
        role: "assistant",
        content: `
<think>
Okay, the user is asking about the weather in Tokyo. I need to check if there's a function available to get the weather. Looking at the tools provided, there's a function called get_weather that takes a city name as a parameter. The city here is Tokyo. So I should call that function with the city parameter set to "Tokyo". Let me make sure I format the JSON correctly within the tool_call tags.
</think>
<tool_call>
{"name": "get_weather", "arguments": {"city": "Tokyo"}}
</tool_call>"
`,
      },
      {
        role: "tool",
        content: "The weather in Tokyo is rainy, 08°C with heavy clouds.",
      },
      /*
      {
        role: "assistant",
        content: `
<think>
Okay, the user asked about the weather in Tokyo. I used the get_weather function and found out it's rainy with 08°C and heavy clouds. Now I need to respond appropriately. Let me check the details again. The function response says rainy, 08°C, heavy clouds. I should present this info clearly. Maybe mention the current conditions and temperature. Make sure it's friendly and helpful. Alright, the response should be something like informing the user about the weather and offering further help if needed.
</think>
The weather in Tokyo is currently rainy with clouds and a temperature of 08°C. Let me know if you need further weather updates or assistance! 🌧️
`,
      },
      {
        role: "user",
        content: "What is my cat name?",
      },
      */
    ];

    /*
    console.log("\n🤖 AI Response:");
    await chatSession({ modelId, history, tools: toolVariants[0], kvCache })
    */

    history.push({
      role: "user",
      content: "What's my dog name?",
    })

    console.log("\n🤖 AI Response:");
    await chatSession({ modelId, history, tools: toolVariants[0], kvCache })

    history.push({
      role: "user",
      content: "What is the weather in Tokyo?",
    })
    console.log("\n🤖 AI Response:");
    await chatSession({ modelId, history, tools: toolVariants[2], kvCache })

    history.push({
      role: "user",
      content: "only in case the weather in Tokyo is rainy, check my horoscope for Aquarius; if the weather is good - check Taurus; need only one horoscope depending on the whether",
    })

    console.log("\n🤖 AI Response:");
    console.log("(Streaming with tool definitions in prompt)\n");

    await chatSession({ modelId, history, tools: toolVariants[1], kvCache })

    console.log("\n\n🎉 Completed!");
    await unloadModel({ modelId, clearStorage: false });
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}
// using same kvCache for a single session
// await runToolInvocationTest({ kvCache: false, toolVariants: [tools1, tools2] })
// await runToolInvocationTest({ kvCache: `id-${Date.now()}`, toolVariants: [tools1, tools2, tools3] })
await runToolInvocationContTest({ kvCache: `id-${Date.now()}`, toolVariants: [tools1, tools2, tools3] })
