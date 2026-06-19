import { loadModel, translate, unloadModel, BERGAMOT_EN_FR } from "@qvac/sdk";

try {
  // Bergamot models automatically derive vocabulary files from the model source.
  // You can still override them explicitly if needed:
  // - srcVocabSrc: source vocabulary file (optional)
  // - dstVocabSrc: target vocabulary file (optional)

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

  const text = "This is a test of the Bergamot translation model.";
  const result = translate({
    modelId,
    text,
    modelType: "nmtcpp-translation",
    stream: false,
  });

  const translatedText = await result.text;
  console.log(`Translated text EN -> FR: ${text} -> "${translatedText}"`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
