import {
  translate,
  loadModel,
  unloadModel,
  AFRICAN_4B_TRANSLATION_Q4_K_M,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: AFRICAN_4B_TRANSLATION_Q4_K_M,
    modelType: "llm",
    onProgress: (progress) => {
      console.log(progress);
    },
    // IMPORTANT: these parameters are validated to be optimal
    modelConfig: {
      tools: true,
      ctx_size: 2048,
      top_k: 1,
      top_p: 1,
      temp: 0,
      repeat_penalty: 1,
      seed: 42,
      predict: 256,
      stop_sequences: ['\n']
    }
  });

  // With explicit source language
  const engText = "Hello, how are you today?";
  const resultExplicit = translate({
    modelId,
    text: engText,
    from: "en",
    to: "arz",
    modelType: "llm",
    stream: false,
  });

  const translatedTextExplicit = await resultExplicit.text;

  console.log(`Explicit source: ${engText} -> "${translatedTextExplicit}"`);


  // With auto detection
  const swahiliText = "Habari yako leo?";
  const resultImplicit = translate({
    modelId,
    text: swahiliText,
    to: "en",
    modelType: "llm",
    stream: false,
  });

  const translatedTextImplicit = await resultImplicit.text;

  console.log(`Auto detect source: ${swahiliText} -> "${translatedTextImplicit}"`);


  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
