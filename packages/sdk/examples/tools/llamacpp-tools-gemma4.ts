/**
 * Tool-calling example using the Gemma4 native dialect.
 *
 * Gemma4 emits tool calls in a JS-literal format with custom quote tokens:
 *   <|tool_call>call:NAME{key:<|"|>val<|"|>,...}<tool_call|>
 *
 * Reasoning output (thinking) is emitted inside <|channel>thought...<channel|>
 * frames, which are stripped from contentDelta and forwarded as thinkingDelta
 * when captureThinking is true.
 *
 * The dialect is auto-detected from the model name/path when the file name
 * contains "gemma4" or "gemma-4". Pass toolDialect: "gemma4" explicitly to
 * completion() if auto-detection does not pick it up for a given file name.
 *
 * Usage:
 *   bun run bare:example dist/examples/tools/llamacpp-tools-gemma4.js <model-url>
 */
import {
  completion,
  loadModel,
  unloadModel,
  GEMMA4_2B_MULTIMODAL_Q4_K_M,
  type ToolCall,
} from "@qvac/sdk";
import { tools, mockExecute } from "./shared";

const modelSrc = process.argv[2] ?? GEMMA4_2B_MULTIMODAL_Q4_K_M;

let modelId: string | undefined;
try {
  modelId = await loadModel({
    modelSrc,
    modelType: "llamacpp-completion",
    modelConfig: { ctx_size: 4096, tools: true },
    onProgress: (progress) =>
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`),
  });
  console.log(`Model loaded: ${modelId}`);

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

  const result = completion({ modelId, history, stream: true, tools });

  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token);
    }
  })();

  const toolsTask = (async () => {
    for await (const evt of result.toolCallStream) {
      if (evt.type === "toolCall") {
        console.log(
          `\n-> ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`,
        );
      }
    }
  })();

  await Promise.all([tokensTask, toolsTask]);

  const toolCalls: ToolCall[] = await result.toolCalls;

  console.log("\n\nFinal tool calls:");
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      console.log(`  - ${call.name}(${JSON.stringify(call.arguments)})`);
      const toolResult = mockExecute(call.name, call.arguments);
      console.log(`    result: ${toolResult}`);
    }
  } else {
    console.log("  (none)");
  }

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("Error:", error);
  if (modelId)
    await unloadModel({ modelId, clearStorage: false }).catch(() => {});
  process.exit(1);
}
