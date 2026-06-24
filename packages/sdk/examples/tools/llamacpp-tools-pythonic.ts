import { completion, loadModel, unloadModel, type ToolCall } from "@qvac/sdk";
import { tools } from "./shared";

const LFM_TOOL_HF =
  "https://huggingface.co/LiquidAI/LFM2-1.2B-Tool-GGUF/resolve/main/LFM2-1.2B-Tool-Q4_K_M.gguf";

try {
  const modelId = await loadModel({
    modelSrc: LFM_TOOL_HF,
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

  console.log("\n▸ Streaming...\n");

  const result = completion({ modelId, history, stream: true, tools });

  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token);
    }
  })();

  const toolsTask = (async () => {
    for await (const evt of result.toolCallStream) {
      console.log(
        `\n▸ ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`,
      );
    }
  })();

  await Promise.all([tokensTask, toolsTask]);

  const toolCalls: ToolCall[] = await result.toolCalls;

  console.log("\n\n▸ Final tool calls:");
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      console.log(`▸ ${call.name}(${JSON.stringify(call.arguments)})`);
    }
  } else {
    console.log("▸ (none)");
  }

  await unloadModel({ modelId });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
