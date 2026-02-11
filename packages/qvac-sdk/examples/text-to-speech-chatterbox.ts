/**
 * Chatterbox TTS example: load from individual model files and optionally use
 * reference audio for voice cloning. Chatterbox outputs 24 kHz audio.
 *
 * Usage:
 *   bun run examples/text-to-speech-chatterbox.ts <chatterbox-model-dir> [ref-audio.wav]
 *   bare ./scripts/bare-bootstrap.js dist/examples/text-to-speech-chatterbox.js <chatterbox-model-dir> [ref-audio.wav]
 *
 * Example:
 *   bun run examples/text-to-speech-chatterbox.ts ./models/chatterbox ./ref.wav
 */
import { loadModel, textToSpeech, unloadModel } from "@qvac/sdk";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { spawnSync } from "child_process";
import { platform } from "os";
import path from "path";

const CHATTERBOX_SAMPLE_RATE = 24000;

/** Read WAV and return mono float samples in [-1, 1] (for Chatterbox reference audio at load time). */
function readWavAsFloat32(wavPath: string): { samples: number[]; sampleRate: number } {
  const buf = readFileSync(wavPath);
  if (buf.length < 44) throw new Error("WAV file too small");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const riff = String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!);
  const wave = String.fromCharCode(buf[8]!, buf[9]!, buf[10]!, buf[11]!);
  if (riff !== "RIFF") throw new Error("Not a RIFF file");
  if (wave !== "WAVE") throw new Error("Not WAVE format");
  let fmtChunk: { offset: number; size: number } | null = null;
  let dataChunk: { offset: number; size: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = String.fromCharCode(
      buf[offset]!,
      buf[offset + 1]!,
      buf[offset + 2]!,
      buf[offset + 3]!,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") fmtChunk = { offset: offset + 8, size: chunkSize };
    else if (chunkId === "data") dataChunk = { offset: offset + 8, size: chunkSize };
    offset += 8 + chunkSize;
    if (chunkSize % 2 === 1 && offset < buf.length) offset += 1;
  }
  if (!fmtChunk || !dataChunk) throw new Error("WAV missing fmt or data chunk");
  const fmtOff = fmtChunk.offset;
  if (fmtOff + 16 > buf.length) throw new Error("fmt chunk truncated");
  const audioFormat = view.getUint16(fmtOff, true);
  const numChannels = view.getUint16(fmtOff + 2, true);
  const sampleRate = view.getUint32(fmtOff + 4, true);
  const bitsPerSample = view.getUint16(fmtOff + 14, true);
  const dataOff = dataChunk.offset;
  const dataLen = Math.min(dataChunk.size, buf.length - dataOff);
  const bytesPerSample = audioFormat === 1 ? 2 : 4;
  const numSamples = Math.floor(dataLen / bytesPerSample);
  const numFrames =
    numChannels === 1 ? numSamples : Math.floor(numSamples / numChannels);
  const samples: number[] = [];
  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = 0; i < numFrames; i++) {
      const idx = dataOff + (numChannels === 1 ? i * 2 : i * numChannels * 2);
      if (idx + 2 > buf.length) break;
      samples.push(view.getInt16(idx, true) / 32768);
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = 0; i < numFrames; i++) {
      const idx = dataOff + (numChannels === 1 ? i * 4 : i * numChannels * 4);
      if (idx + 4 > buf.length) break;
      samples.push(view.getFloat32(idx, true));
    }
  } else {
    throw new Error(
      `Unsupported WAV: format=${audioFormat}, bits=${bitsPerSample}`,
    );
  }
  return { samples, sampleRate };
}

console.log("Starting Chatterbox TTS example...");

const modelDirRaw = process.argv[2];
const refAudioPath = process.argv[3];

if (!modelDirRaw) {
  console.error("Usage: <script> <chatterbox-model-dir> [ref-audio.wav]");
  process.exit(1);
}

const modelDir = path.resolve(modelDirRaw);
const tokenizerSrc = path.join(modelDir, "tokenizer.json");
const speechEncoderSrc = path.join(modelDir, "speech_encoder.onnx");
const embedTokensSrc = path.join(modelDir, "embed_tokens.onnx");
const conditionalDecoderSrc = path.join(modelDir, "conditional_decoder.onnx");
const languageModelSrc = path.join(modelDir, "language_model.onnx");

try {
  let referenceAudioSamples: number[] | undefined;
  if (refAudioPath) {
    const refPath = path.resolve(refAudioPath);
    const { samples } = readWavAsFloat32(refPath);
    referenceAudioSamples = samples;
    console.log(`Using reference audio: ${refPath} (${samples.length} samples)`);
  }

  console.log("Loading Chatterbox TTS model...");
  const modelId = await loadModel({
    modelType: "tts",
    modelConfig: { language: "en" },
    tokenizerSrc,
    speechEncoderSrc,
    embedTokensSrc,
    conditionalDecoderSrc,
    languageModelSrc,
    referenceAudio: referenceAudioSamples,
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`Model loaded: ${modelId}`);

  const ttsParams: Parameters<typeof textToSpeech>[0] = {
    modelId,
    text: "Hello world. This is a test of the Chatterbox text to speech system.",
    inputType: "text",
    stream: false,
  };

  console.log("Synthesizing speech...");
  const result = textToSpeech(ttsParams);
  const audioBuffer = await result.buffer;
  console.log(`TTS complete. Total samples: ${audioBuffer.length}`);

  const outFile = "chatterbox-output.wav";
  createWav(audioBuffer, CHATTERBOX_SAMPLE_RATE, outFile);
  console.log(`Audio saved to ${outFile}`);

  console.log("Playing audio...");
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, CHATTERBOX_SAMPLE_RATE),
    audioData,
  ]);
  playAudio(wavBuffer);
  console.log("Playback complete");

  await unloadModel({ modelId });
  console.log("Model unloaded");
  process.exit(0);
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}

function createWavHeader(
  dataLength: number,
  sampleRate: number,
): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function int16ArrayToBuffer(int16Array: number[]): Buffer {
  const buffer = Buffer.alloc(int16Array.length * 2);
  for (let i = 0; i < int16Array.length; i++) {
    buffer.writeInt16LE(int16Array[i] ?? 0, i * 2);
  }
  return buffer;
}

function createWav(
  audioBuffer: number[],
  sampleRate: number,
  filename: string,
): void {
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavFile = Buffer.concat([
    createWavHeader(audioData.length, sampleRate),
    audioData,
  ]);
  writeFileSync(filename, wavFile);
}

function playAudio(audioBuffer: Buffer): void {
  const tempFile = `/tmp/chatterbox-${Date.now()}.wav`;
  writeFileSync(tempFile, audioBuffer);
  const currentPlatform = platform();
  const [player, args] =
    currentPlatform === "darwin"
      ? ["afplay", [tempFile]]
      : currentPlatform === "win32"
        ? [
            "powershell",
            [
              "-Command",
              `Add-Type -AssemblyName presentationCore; (New-Object Media.SoundPlayer).LoadStream([System.IO.File]::ReadAllBytes('${tempFile}')).PlaySync()`,
            ],
          ]
        : ["aplay", [tempFile]];
  const result = spawnSync(player, args, { stdio: ["inherit", "inherit", "inherit"] });
  try {
    unlinkSync(tempFile);
  } catch {
    // ignore
  }
  if (result.error) throw new Error(`Audio player failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Audio player exited with code ${result.status}`);
}
