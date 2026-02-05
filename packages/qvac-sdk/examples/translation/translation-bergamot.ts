// NOTE: Bergamot models are not yet in the registry
// This example uses OPUS en->de model as a substitute
import { loadModel, translate, unloadModel, OPUS_EN_DE_Q4_0 } from "@qvac/sdk";

try {
  // Vocabulary files are automatically derived from the model source.
  // You can still override them explicitly if needed:
  // - srcVocabSrc: source vocabulary file (optional)
  // - dstVocabSrc: target vocabulary file (optional)

  const modelId = await loadModel({
    modelSrc: OPUS_EN_DE_Q4_0,
    modelType: "nmt",
    modelConfig: {
      engine: "Opus",
      from: "en",
      to: "de",
      beamsize: 1,
      temperature: 0.2,
      norepeatngramsize: 3,
      lengthpenalty: 1.2,
    },
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`✅ Model loaded: ${modelId}`);

  const text = "This is a test of the translation model.";
  const result = translate({
    modelId,
    text,
    modelType: "nmt",
    stream: false,
  });

  const translatedText = await result.text;
  console.log(`Translated text EN -> DE: ${text} -> "${translatedText}"`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
