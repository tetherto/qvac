import {
  translate,
  loadModel,
  unloadModel,
  SALAMANDRATA_2B_INST_Q8,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: SALAMANDRATA_2B_INST_Q8,
    modelType: "llm",
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`✅ Model loaded: ${modelId}`);

  // With explicit source language
  const engText = "bank";
  const resultExplicit = translate({
    modelId,
    text: engText,
    from: "en",
    to: "es",
    modelType: "llm",
    context: "Use formal language, letter for financial institution",
    stream: false,
  });

  const translatedTextExplicit = await resultExplicit.text;

  console.log(`${engText} -> "${translatedTextExplicit}"`); // "banco" (not "orilla")

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
