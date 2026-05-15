/**
 * Parakeet Sortformer diarization + TDT transcription example.
 *
 * Usage:
 *   bun examples/transcription/parakeet-sortformer.ts [sortformer-src] [path-to-audio]
 *
 * This example requires a test audio file (default: examples/audio/diarization-sample-16k.wav).
 * Sample audio files are available in the QVAC source repository, but not included in the published npm package.
 * Pass a custom audio path as the second argument, or download the default audio into examples/audio/:
 *   https://github.com/tetherto/qvac/blob/main/packages/sdk/examples/audio/diarization-sample-16k.wav
 */
import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
  PARAKEET_SORTFORMER_FP32,
} from "@qvac/sdk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const sortformerSrc = args[0] ?? PARAKEET_SORTFORMER_FP32;

const defaultAudioPath = join(
  __dirname,
  "..",
  "audio",
  "diarization-sample-16k.wav",
);
const audioFilePath = args[1] ?? defaultAudioPath;

// ── Step 1: Diarize with Sortformer ──

const sfModelId = await loadModel({
  modelSrc: sortformerSrc,
  modelType: "parakeet",
  modelConfig: {
    modelType: "sortformer",
    parakeetSortformerSrc: sortformerSrc,
  },
});

const diarization = await transcribe({
  modelId: sfModelId,
  audioChunk: audioFilePath,
});
await unloadModel({ modelId: sfModelId });

const segments = parseDiarization(diarization);

// ── Step 2: Transcribe each segment with TDT ──

const tdtModelId = await loadModel({
  modelSrc: PARAKEET_TDT_ENCODER_FP32,
  modelType: "parakeet",
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_FP32,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_FP32,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_FP32,
  },
});

const pcm = readPcm(audioFilePath);
const sliceDir = join(tmpdir(), `qvac-diarize-${Date.now()}`);
mkdirSync(sliceDir, { recursive: true });

const results: { speaker: number; start: number; end: number; text: string }[] =
  [];

for (let i = 0; i < segments.length; i++) {
  const seg = segments[i]!;
  const slicePath = join(sliceDir, `seg-${i}.wav`);

  if (!writeWavSlice(pcm, seg.start, seg.end, slicePath)) {
    results.push({ ...seg, text: "[No speech detected]" });
    continue;
  }

  const text = await transcribe({ modelId: tdtModelId, audioChunk: slicePath });
  results.push({ ...seg, text: text.trim() || "[No speech detected]" });
}

await unloadModel({ modelId: tdtModelId });

// ── Step 3: Merge consecutive same-speaker segments and print ──

const merged = mergeSpeakers(results);

console.log("\n=== DIARIZED TRANSCRIPTION ===");
console.log("=".repeat(60));
for (const entry of merged) {
  console.log(
    `Speaker ${entry.speaker} (${entry.start.toFixed(2)}s - ${entry.end.toFixed(2)}s):`,
  );
  console.log(`  ${entry.text}\n`);
}
console.log("=".repeat(60));
console.log("\nDone!");

// ── Helpers ──

function parseDiarization(text: string) {
  const segs: { speaker: number; start: number; end: number }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/Speaker (\d+): ([\d.]+)s - ([\d.]+)s/);
    if (m) segs.push({ speaker: +m[1]!, start: +m[2]!, end: +m[3]! });
  }
  return segs.sort((a, b) => a.start - b.start);
}

function readPcm(wavPath: string): Buffer {
  const buf = readFileSync(wavPath);
  const dataOffset = buf.indexOf("data") + 4;
  return buf.subarray(dataOffset + 4, dataOffset + 4 + buf.readUInt32LE(dataOffset));
}

function writeWavSlice(
  pcm: Buffer,
  startSec: number,
  endSec: number,
  outPath: string,
): boolean {
  const SR = 16000;
  const BPS = 2;
  const startByte = Math.floor(startSec * SR) * BPS;
  const endByte = Math.min(Math.ceil(endSec * SR) * BPS, pcm.length);
  if (startByte >= endByte) return false;

  const slice = pcm.subarray(startByte, endByte);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + slice.length, 4);
  hdr.write("WAVEfmt ", 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(SR, 24);
  hdr.writeUInt32LE(SR * BPS, 28);
  hdr.writeUInt16LE(BPS, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(slice.length, 40);

  writeFileSync(outPath, Buffer.concat([hdr, slice]));
  return true;
}

function mergeSpeakers<T extends { speaker: number; start: number; end: number; text: string }>(
  entries: T[],
): T[] {
  const out: T[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.speaker === e.speaker) {
      last.text += " " + e.text;
      last.end = e.end;
    } else {
      out.push({ ...e });
    }
  }
  return out;
}
