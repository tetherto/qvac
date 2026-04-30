import {
  translate,
  loadModel,
  unloadModel,
  SALAMANDRATA_2B_INST_Q4,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: SALAMANDRATA_2B_INST_Q4,
    modelType: "llm",
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  // With explicit source language
  const engText = "Hello, how are you today?";
  const resultExplicit = translate({
    modelId,
    text: engText,
    from: "en",
    to: "it",
    modelType: "llm",
    stream: false,
  });

  const translatedTextExplicit = await resultExplicit.text;

  // With autodetection (must await previous translate — LLM addon runs one job at a time)
  const espText = "Hola, como estas?";
  const resultAutodetect = translate({
    modelId,
    text: espText,
    to: "en",
    modelType: "llm",
    stream: false,
  });

  const translatedTextAutodetect = await resultAutodetect.text;

  console.log(`Explicit source: ${engText} -> "${translatedTextExplicit}"`);
  console.log(
    `Autodetected source: ${espText} -> "${translatedTextAutodetect}"`,
  );

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
