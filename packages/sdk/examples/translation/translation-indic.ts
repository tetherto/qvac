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
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
    modelConfig: {
      engine: "IndicTrans",
      from: "eng_Latn",
      to: "hin_Deva",
    },
  });

  console.log(`▸ Model loaded: ${modelId}`);

  const text = "Hello, how are you today?";
  const result = translate({
    modelId,
    text,
    modelType: "nmtcpp-translation",
    stream: false,
  });

  const translatedText = await result.text;
  console.log(`Translated text EN -> HI: ${text} -> "${translatedText}"`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
