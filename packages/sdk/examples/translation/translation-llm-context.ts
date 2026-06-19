import {
  translate,
  loadModel,
  unloadModel,
  SALAMANDRATA_2B_INST_Q8,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: SALAMANDRATA_2B_INST_Q8,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  console.log(`▸ Model loaded: ${modelId}`);

  // With explicit source language
  const engText = "bank";
  const resultExplicit = translate({
    modelId,
    text: engText,
    from: "en",
    to: "es",
    modelType: "llamacpp-completion",
    context: "Use formal language, letter for financial institution",
    stream: false,
  });

  const translatedTextExplicit = await resultExplicit.text;

  console.log(`${engText} -> "${translatedTextExplicit}"`); // "banco" (not "orilla")

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
