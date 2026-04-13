/**
 * Standalone model downloader for CI caching.
 *
 * Downloads all mobile bootstrap models (non-skipPreDownload) using the SDK's
 * Node.js API. Run with: bun run scripts/download-mobile-models.ts
 *
 * Respects QVAC_CONFIG_PATH / cacheDirectory for controlling where models land.
 *
 * Keep the model list in sync with tests/mobile/consumer.ts resource definitions.
 */
import { downloadAsset } from "@qvac/sdk";
import type { ModelConstant } from "@qvac/sdk";
import {
  LLAMA_3_2_1B_INST_Q4_0,
  GTE_LARGE_FP16,
  WHISPER_TINY,
  QWEN3_1_7B_INST_Q4,
  OCR_LATIN_RECOGNIZER_1,
  MARIAN_OPUS_DE_EN_Q4_0,
  MARIAN_OPUS_EN_ES_Q4_0,
  MARIAN_OPUS_ES_EN_Q4_0,
  MARIAN_EN_HI_INDIC_200M_Q4_0,
  MARIAN_HI_EN_INDIC_200M_Q4_0,
  BERGAMOT_EN_FR,
  BERGAMOT_EN_ES,
  BERGAMOT_ES_EN,
  SALAMANDRATA_2B_INST_Q4,
  AFRICAN_4B_TRANSLATION_Q4_K_M,
  SD_V2_1_1B_Q8_0,
} from "@qvac/sdk";

const models: { name: string; constant: ModelConstant }[] = [
  { name: "llm", constant: LLAMA_3_2_1B_INST_Q4_0 },
  { name: "embeddings", constant: GTE_LARGE_FP16 },
  { name: "whisper", constant: WHISPER_TINY },
  { name: "tools", constant: QWEN3_1_7B_INST_Q4 },
  { name: "ocr", constant: OCR_LATIN_RECOGNIZER_1 },
  { name: "marian-de-en", constant: MARIAN_OPUS_DE_EN_Q4_0 },
  { name: "marian-en-es", constant: MARIAN_OPUS_EN_ES_Q4_0 },
  { name: "marian-es-en", constant: MARIAN_OPUS_ES_EN_Q4_0 },
  { name: "indictrans-en-hi", constant: MARIAN_EN_HI_INDIC_200M_Q4_0 },
  { name: "indictrans-hi-en", constant: MARIAN_HI_EN_INDIC_200M_Q4_0 },
  { name: "bergamot-en-fr", constant: BERGAMOT_EN_FR },
  { name: "bergamot-en-es", constant: BERGAMOT_EN_ES },
  { name: "bergamot-es-en", constant: BERGAMOT_ES_EN },
  { name: "salamandra", constant: SALAMANDRATA_2B_INST_Q4 },
  { name: "afriquegemma", constant: AFRICAN_4B_TRANSLATION_Q4_K_M },
  { name: "diffusion", constant: SD_V2_1_1B_Q8_0 },
];

async function main() {
  console.log(`Downloading ${models.length} mobile bootstrap models...\n`);
  const start = Date.now();
  let completed = 0;

  const results = await Promise.allSettled(
    models.map(async ({ name, constant }, index) => {
      console.log(`[${index + 1}/${models.length}] Downloading ${name}: ${constant.name}...`);
      await downloadAsset({ assetSrc: constant as never });
      completed++;
      console.log(`[${completed}/${models.length}] Done: ${name}`);
      return name;
    }),
  );

  const failed = results.filter((r) => r.status === "rejected");
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (failed.length > 0) {
    console.error(`\n${failed.length}/${models.length} downloads failed:`);
    for (const f of failed) {
      console.error(`  - ${(f as PromiseRejectedResult).reason}`);
    }
    process.exit(1);
  }

  console.log(`\nAll ${models.length} models downloaded in ${elapsed}s`);
  process.exit(0);
}

main();
