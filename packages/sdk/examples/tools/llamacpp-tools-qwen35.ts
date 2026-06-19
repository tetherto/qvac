/**
 * Tool-calling example using the Qwen3.5 dialect.
 *
 * Qwen3.5 emits tool calls in a Pythonic-XML format:
 *   <tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>
 *
 * The dialect is auto-detected from the model name/path when the model file
 * contains "qwen3.5", "qwen3-5", "qwen3.6", or "qwen3-6". Pass
 * toolDialect: "qwen35" explicitly if auto-detection does not pick it up.
 *
 * Usage:
 *   bun run bare:example dist/examples/tools/llamacpp-tools-qwen35.js <model-url>
 */
import {
  completion,
  loadModel,
  unloadModel,
  QWEN3_5_0_8B_MULTIMODAL_Q8_0,
  type ToolCall,
} from "@qvac/sdk";
import { tools, mockExecute } from "./shared";

const modelSrc = process.argv[2] ?? QWEN3_5_0_8B_MULTIMODAL_Q8_0;

let modelId: string | undefined;
try {
  modelId = await loadModel({
    modelSrc,
    modelType: "llamacpp-completion",
    modelConfig: { ctx_size: 4096, tools: true },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ Model loaded: ${modelId}`);

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
          `\n▸ ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`,
        );
      }
    }
  })();

  await Promise.all([tokensTask, toolsTask]);

  const toolCalls: ToolCall[] = await result.toolCalls;

  console.log("\n\n▸ Final tool calls:");
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      console.log(`▸ ${call.name}(${JSON.stringify(call.arguments)})`);
      const toolResult = mockExecute(call.name, call.arguments);
      console.log(`▸ result: ${toolResult}`);
    }
  } else {
    console.log("▸ (none)");
  }

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("✖", error);
  if (modelId)
    await unloadModel({ modelId, clearStorage: false }).catch(() => {});
  process.exit(1);
}
