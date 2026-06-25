import {
  translate,
  loadModel,
  unloadModel,
  SALAMANDRATA_2B_INST_Q4,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: SALAMANDRATA_2B_INST_Q4,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  // With explicit source language
  const engText = "Hello, how are you today?";
  const resultExplicit = translate({
    modelId,
    text: engText,
    from: "en",
    to: "it",
    modelType: "llamacpp-completion",
    stream: false,
  });

  const translatedTextExplicit = await resultExplicit.text;

  // With autodetection (must await previous translate — LLM addon runs one job at a time)
  const espText = "Hola, como estas?";
  const resultAutodetect = translate({
    modelId,
    text: espText,
    to: "en",
    modelType: "llamacpp-completion",
    stream: false,
  });

  const translatedTextAutodetect = await resultAutodetect.text;

  console.log(`Explicit source: ${engText} -> "${translatedTextExplicit}"`);
  console.log(
    `Autodetected source: ${espText} -> "${translatedTextAutodetect}"`,
  );

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
