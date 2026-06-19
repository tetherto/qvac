/**
 * Stream an LLM and forward token deltas through the duplex TTS path (`textToSpeechStream` →
 * `runStreaming` with `accumulateSentences: true`). Text is filtered before TTS / console: any
 * `<...>` span (including across tokens) is removed, and `*` characters are stripped.
 *
 * Each synthesized phrase is played as soon as PCM arrives (`playPcmInt16Chunk`). A combined WAV
 * is written at the end for inspection.
 *
 * Prerequisites: Bun, QVAC worker, registry access, macOS `afplay` / Linux `aplay` (or Windows
 * PowerShell player) for chunk playback.
 *
 * Usage:
 *   bun run examples/tts/llm-to-tts-streaming.ts
 */

import {
  completion,
  loadModel,
  textToSpeechStream,
  unloadModel,
  type ModelProgressUpdate,
  LLAMA_3_2_1B_INST_Q4_0,
  TTS_EN_SUPERTONIC_Q8_0,
} from "@qvac/sdk";
import { createWav, playPcmInt16Chunk } from "./utils";

const SUPERTONIC_SAMPLE_RATE = 44100;

/**
 * Drop angle-bracket spans (e.g. `<think>…</think>`, `<|foo|>`) even when split across tokens,
 * and strip `*` (markdown emphasis) from text passed to TTS and the console.
 */
function createAngleBracketAndStarFilter() {
  let inAngle = false;
  return function filterChunk(chunk: string): string {
    let out = "";
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (inAngle) {
        if (c === ">") {
          inAngle = false;
        }
        continue;
      }
      if (c === "<") {
        inAngle = true;
        continue;
      }
      if (c === "*") {
        continue;
      }
      out += c;
    }
    return out;
  };
}

/**
 * Append PCM without `push(...huge)` — a spread of hundreds of thousands of
 * arguments blows the V8 / Bare argument-count limit. Batching with
 * `Array.prototype.push.apply` is both faster than `push(...slice)` and
 * avoids allocating an intermediate rest array on the stack per call.
 */
function appendPcmSamples(target: number[], chunk: number[]) {
  const batch = 8192;
  for (let i = 0; i < chunk.length; i += batch) {
    const end = Math.min(i + batch, chunk.length);
    Array.prototype.push.apply(target, chunk.slice(i, end));
  }
}

try {
  console.log(`▸ Loading LLM from registry: ${LLAMA_3_2_1B_INST_Q4_0.name}`);
  const llmModelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: {
      ctx_size: 2048,
    },
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ LLM ready: ${llmModelId}`);

  console.log("▸ Loading Supertonic TTS (registry)…");
  const ttsModelId = await loadModel({
    modelSrc: TTS_EN_SUPERTONIC_Q8_0,
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      voice: "F1",
      ttsSpeed: 1.05,
      ttsNumInferenceSteps: 10,
    },
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ TTS ready: ${ttsModelId}`);

  const prompt = "What is a constellation?";

  console.log(`▸ User: ${prompt}`);
  console.log("▸ Assistant (streaming):");

  const result = completion({
    modelId: llmModelId,
    history: [{ role: "user", content: prompt }],
    stream: true,
  });

  const combinedPcm: number[] = [];

  const ttsSession = await textToSpeechStream({
    modelId: ttsModelId,
    inputType: "text",
    accumulateSentences: true,
  });

  let phraseIndex = 0;
  const filterChunk = createAngleBracketAndStarFilter();

  const drainPcm = (async () => {
    for await (const m of ttsSession) {
      if (m.buffer.length > 0) {
        appendPcmSamples(combinedPcm, m.buffer);
        phraseIndex += 1;
        const preview =
          typeof m.sentenceChunk === "string"
            ? m.sentenceChunk.replace(/\s+/g, " ").trim().slice(0, 72)
            : "";
        console.log(
          `\n▸ [TTS phrase ${phraseIndex}] ${m.buffer.length} samples${preview ? ` — "${preview}${preview.length >= 72 ? "..." : ""}"` : ""}`,
        );
        await playPcmInt16Chunk(m.buffer, SUPERTONIC_SAMPLE_RATE);
      }
    }
  })();

  for await (const token of result.tokenStream) {
    const cleaned = filterChunk(token);
    if (cleaned.length > 0) {
      process.stdout.write(cleaned);
      ttsSession.write(cleaned);
    }
  }
  ttsSession.end();
  await drainPcm;

  const stats = await result.stats;
  if (stats) {
    console.log("\n▸ LLM stats:", stats);
  }

  const outWav = "llm-to-tts-streaming-output.wav";
  console.log(
    `\n▸ Writing ${combinedPcm.length} samples to ${outWav} (full utterance; phrases were already played above).`,
  );
  createWav(combinedPcm, SUPERTONIC_SAMPLE_RATE, outWav);

  await unloadModel({ modelId: llmModelId, clearStorage: false });
  await unloadModel({ modelId: ttsModelId, clearStorage: false });
  console.log("▸ Models unloaded.");
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
