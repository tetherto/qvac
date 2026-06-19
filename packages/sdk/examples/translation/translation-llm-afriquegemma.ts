import {
  translate,
  loadModel,
  unloadModel,
  AFRICAN_4B_TRANSLATION_Q4_K_M,
} from "@qvac/sdk";

try {
  const modelId = await loadModel({
    modelSrc: AFRICAN_4B_TRANSLATION_Q4_K_M,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
    // IMPORTANT: these parameters are validated to be optimal
    modelConfig: {
      tools: true,
      ctx_size: 2048,
      top_k: 1,
      top_p: 1,
      temp: 0,
      repeat_penalty: 1,
      seed: 42,
      predict: 256,
      stop_sequences: ["\n"],
    },
  });

  // With explicit source language
  const engText = "Hello, how are you today?";
  const resultExplicit = translate({
    modelId,
    text: engText,
    from: "en",
    to: "swh_Latn",
    modelType: "llamacpp-completion",
    stream: false,
  });

  const translatedTextExplicit = await resultExplicit.text;

  console.log(`Explicit source: ${engText} -> "${translatedTextExplicit}"`);

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
