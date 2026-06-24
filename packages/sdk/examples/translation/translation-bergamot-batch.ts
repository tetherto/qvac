import { loadModel, translate, unloadModel, BERGAMOT_EN_FR } from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: BERGAMOT_EN_FR,
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
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  console.log(`▸ Bergamot model loaded: ${modelId}`);

  // Test with array of texts for batch processing
  const texts = [
    "Hello world",
    "How are you today?",
    "This is a test of batch translation",
    "The weather is nice",
  ];

  console.log("▸ Translating batch of texts:");
  texts.forEach((text, i) => console.log(`▸   ${i + 1}. ${text}`));

  const result = translate({
    modelId,
    text: texts, // Pass array for batch processing
    modelType: "nmtcpp-translation",
    stream: false,
  });

  const translatedText = await result.text;
  const translations = translatedText.split("\n");

  console.log("▸ Translations:");
  translations.forEach((translation, i) => {
    if (i < texts.length) {
      console.log(`  ${i + 1}. ${texts[i]} -> "${translation}"`);
    }
  });

  await unloadModel({ modelId });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
