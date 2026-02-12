import { loadModel, translate, unloadModel, BERGAMOT_ENFR } from "@qvac/sdk";

try {
  // Bergamot models automatically derive vocabulary files from the model source
  // when using pear:// URLs. You can still override them explicitly if needed:
  // - srcVocabSrc: source vocabulary file (optional)
  // - dstVocabSrc: target vocabulary file (optional)

  const modelId = await loadModel({
    modelSrc: BERGAMOT_ENFR,
    modelType: "nmt",
    modelConfig: {
      engine: "Bergamot",
      from: "en",
      to: "fr",
      beamsize: 1,
      normalize: 1,
      temperature: 0.2,
      norepeatngramsize: 3,
      lengthpenalty: 1.2,
    },
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`✅ Bergamot model loaded: ${modelId}`);

  const text = "This is a test of the Bergamot translation model.";
  const result = translate({
    modelId,
    text,
    modelType: "nmt",
    stream: false,
  });

  const translatedText = await result.text;
  console.log(`Translated text EN -> FR: ${text} -> "${translatedText}"`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
