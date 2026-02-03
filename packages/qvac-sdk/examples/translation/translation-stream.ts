import {
  loadModel,
  translate,
  MARIAN_OPUS_EN_IT_Q0F32,
  unloadModel,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: MARIAN_OPUS_EN_IT_Q0F32,
    modelType: "nmt",
    modelConfig: {
      engine: "Opus",
      from: "en",
      to: "it",
    },
  });

  console.log(`✅ Model loaded: ${modelId}`);

  const text =
    "Hello, how are you today? I hope you are having a wonderful day!";

  console.log("\n--- Streaming Translation ---");
  const streamResult = translate({
    modelId,
    text,
    modelType: "nmt",
    stream: true,
  });

  process.stdout.write("Translated text EN -> IT: ");
  for await (const token of streamResult.tokenStream) {
    process.stdout.write(token);
  }
  console.log();

  const stats = await streamResult.stats;
  if (stats) {
    console.log(`Processing stats:`, stats);
  }

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
