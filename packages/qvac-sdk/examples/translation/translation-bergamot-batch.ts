// NOTE: Bergamot models are not yet in the registry
// This example uses OPUS en->de model to demonstrate batch translation
import { loadModel, translate, unloadModel, OPUS_EN_DE_Q4_0 } from "@qvac/sdk";

try {
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

  // Test with array of texts for batch processing
  const texts = [
    "Hello world",
    "How are you today?",
    "This is a test of batch translation",
    "The weather is nice",
  ];

  console.log("\n📝 Translating batch of texts:");
  texts.forEach((text, i) => console.log(`  ${i + 1}. ${text}`));

  const result = translate({
    modelId,
    text: texts, // Pass array for batch processing
    modelType: "nmt",
    stream: false,
  });

  const translatedText = await result.text;
  const translations = translatedText.split("\n");

  console.log("\n✅ Translations:");
  translations.forEach((translation, i) => {
    if (i < texts.length) {
      console.log(`  ${i + 1}. ${texts[i]} -> "${translation}"`);
    }
  });

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
