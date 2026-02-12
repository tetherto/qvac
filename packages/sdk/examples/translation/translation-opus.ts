import {
  loadModel,
  translate,
  unloadModel,
  MARIAN_OPUS_EN_IT_Q0F32,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: MARIAN_OPUS_EN_IT_Q0F32,
    modelType: "nmt",
    modelConfig: {
      engine: "Opus",
      from: "en",
      to: "it",
      temperature: 0.2,
      norepeatngramsize: 3,
      lengthpenalty: 1.2,
    },
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`✅ Model loaded: ${modelId}`);

  const text = "Hello, how are you today?";
  const result = translate({
    modelId,
    text,
    modelType: "nmt",
    stream: false,
  });

  const translatedText = await result.text;
  console.log(`Translated text EN -> IT: ${text} -> "${translatedText}"`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
