import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
} from "@qvac/sdk";
import { writeFileSync, unlinkSync } from "fs";
import { spawnSync } from "child_process";
import { platform } from "os";

// Supertonic TTS: general-purpose, no voice cloning. Pass paths in order: tokenizer, text_encoder, latent_denoiser, voice_decoder, voice.bin
// Usage: node supertonic-filesystem.js <ttsTokenizerSrc> <ttsTextEncoderSrc> <ttsLatentDenoiserSrc> <ttsVoiceDecoderSrc> <ttsVoiceSrc>
const [
  ttsTokenizerSrc,
  ttsTextEncoderSrc,
  ttsLatentDenoiserSrc,
  ttsVoiceDecoderSrc,
  ttsVoiceSrc,
] = process.argv.slice(2);

if (
  !ttsTokenizerSrc ||
  !ttsTextEncoderSrc ||
  !ttsLatentDenoiserSrc ||
  !ttsVoiceDecoderSrc ||
  !ttsVoiceSrc
) {
  console.error(
    "Usage: node supertonic-filesystem.js <ttsTokenizerSrc> <ttsTextEncoderSrc> <ttsLatentDenoiserSrc> <ttsVoiceDecoderSrc> <ttsVoiceSrc>",
  );
  process.exit(1);
}

const modelSrc = ttsTokenizerSrc;
const SUPERTONIC_SAMPLE_RATE = 44100;

try {
  const modelId = await loadModel({
    modelSrc,
    modelType: "tts",
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      ttsTokenizerSrc,
      ttsTextEncoderSrc,
      ttsLatentDenoiserSrc,
      ttsVoiceDecoderSrc,
      ttsVoiceSrc,
    },
    onProgress: (progress: ModelProgressUpdate) => {
      console.log(progress);
    },
  });

  console.log(`Model loaded: ${modelId}`);

  console.log("🎵 Testing Text-to-Speech...");
  const result = textToSpeech({
    modelId,
    text: `QVAC SDK is the canonical entry point to QVAC. Written in TypeScript, it provides all QVAC capabilities through a unified interface while also abstracting away the complexity of running your application in a JS environment other than Bare. Supported JS environments include Bare, Node.js, Expo and Bun.`,
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  console.log(`TTS complete. Total samples: ${audioBuffer.length}`);

  console.log("💾 Saving audio to file...");
  createWav(audioBuffer, SUPERTONIC_SAMPLE_RATE, "supertonic-output.wav");
  console.log("✅ Audio saved to supertonic-output.wav");

  console.log("🔊 Playing audio...");
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, SUPERTONIC_SAMPLE_RATE),
    audioData,
  ]);
  playAudio(wavBuffer);
  console.log("✅ Audio playback complete");

  await unloadModel({ modelId });
  console.log("Model unloaded");
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}

function createWavHeader(
  dataLength: number,
  sampleRate: number = SUPERTONIC_SAMPLE_RATE,
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

function int16ArrayToBuffer(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0)));
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

function createWav(
  audioBuffer: number[],
  sampleRate: number,
  filename: string,
): void {
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavHeader = createWavHeader(audioData.length, sampleRate);
  writeFileSync(filename, Buffer.concat([wavHeader, audioData]));
  console.log(`WAV file saved as: ${filename}`);
}

function playAudio(audioBuffer: Buffer): void {
  const currentPlatform = platform();
  const tempFile = `/tmp/audio-${Date.now()}.wav`;
  writeFileSync(tempFile, audioBuffer);

  let audioPlayer: string;
  let args: string[];
  switch (currentPlatform) {
    case "darwin":
      audioPlayer = "afplay";
      args = [tempFile];
      break;
    case "linux":
      audioPlayer = "aplay";
      args = [tempFile];
      break;
    case "win32":
      audioPlayer = "powershell";
      args = [
        "-Command",
        `Add-Type -AssemblyName presentationCore; (New-Object Media.SoundPlayer).LoadStream([System.IO.File]::ReadAllBytes('${tempFile}')).PlaySync()`,
      ];
      break;
    default:
      audioPlayer = "aplay";
      args = [tempFile];
  }

  const result = spawnSync(audioPlayer, args, {
    stdio: ["inherit", "inherit", "inherit"],
  });
  try {
    unlinkSync(tempFile);
  } catch {
    // ignore
  }
  if (result.error) {
    throw new Error(`Audio player failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Audio player exited with code ${result.status}`);
  }
}
