import {
  loadModel,
  translate,
  unloadModel,
  MARIAN_EN_HI_INDIC_1B_Q4_0,
} from "@qvac/sdk";

// NOTE: @qvac/translation-nmtcpp version 0.1.6 does not work well with IndicTrans models
// This example is expected to fail
// A fix is in progress for future releases

try {
  const modelId = await loadModel({
    modelSrc: MARIAN_EN_HI_INDIC_1B_Q4_0,
    modelType: "nmt",
    onProgress: (progress) => {
      console.log(progress);
    },
    modelConfig: {
      engine: "IndicTrans",
      from: "eng_Latn",
      to: "hin_Deva",
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
  console.log(`Translated text EN -> HI: ${text} -> "${translatedText}"`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
