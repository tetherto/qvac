import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  TTS_S3GEN_EN_CHATTERBOX,
  TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0,
  TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q8_0,
} from "@qvac/sdk";
import { createWav } from "./utils";

// Reproduction harness for the "Chatterbox speaks too fast" symptom.
// Synthesizes a fixed sentence per language, then derives speaking rate from
// the audio sample count:  wpm = words / (samples / sampleRate / 60).
// A natural rate is ~150-165 wpm; the report claims EN ~200 wpm.

const SAMPLE_RATE = 24000;

function progress(p: ModelProgressUpdate) {
  const mb = (n: number) => (n / 1e6).toFixed(1);
  const line = `  ▸ download ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
  process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
  if (p.percentage >= 100) process.stderr.write("\n");
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function synth(modelId: string, language: string, text: string) {
  const result = textToSpeech({ modelId, text, inputType: "text", stream: false });
  const buffer = await result.buffer;

  const samples = buffer.length;
  const durationSec = samples / SAMPLE_RATE;
  const words = wordCount(text);
  const wpm = words / (durationSec / 60);

  const outFile = `repro-${language}.wav`;
  createWav(buffer, SAMPLE_RATE, outFile);

  console.log(`  text words : ${words}`);
  console.log(`  samples    : ${samples}`);
  console.log(`  duration   : ${durationSec.toFixed(2)} s`);
  console.log(`  >>> RATE   : ${wpm.toFixed(1)} wpm  (natural ~150-165)`);
  console.log(`  wav        : ${outFile}`);
  return { language, words, durationSec, wpm };
}

const EN_TEXT =
  "The quick brown fox jumps over the lazy dog while the morning sun rises slowly above the quiet valley and the river flows gently toward the distant sea.";
const IT_TEXT =
  "La volpe marrone salta sopra il cane pigro mentre il sole del mattino sorge lentamente sopra la valle tranquilla e il fiume scorre dolcemente verso il mare lontano.";

try {
  const results = [];

  console.log("\n=== Chatterbox EN Turbo (lang=en) ===");
  const enId = await loadModel({
    modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
      streamChunkTokens: 25,
      streamFirstChunkTokens: 10,
      cfmSteps: 1,
      threads: 8,
    },
    onProgress: progress,
  });
  results.push(await synth(enId, "en", EN_TEXT));
  await unloadModel({ modelId: enId });

  console.log("\n=== Chatterbox MTL (lang=it) ===");
  const itId = await loadModel({
    modelSrc: TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0,
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "it",
      s3genModelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q8_0.src,
      streamChunkTokens: 25,
      streamFirstChunkTokens: 10,
      cfmSteps: 1,
      threads: 8,
    },
    onProgress: progress,
  });
  results.push(await synth(itId, "it", IT_TEXT));
  await unloadModel({ modelId: itId });

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`  ${r.language.padEnd(4)} ${r.wpm.toFixed(1)} wpm  (${r.durationSec.toFixed(2)}s, ${r.words} words)`);
  }
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
