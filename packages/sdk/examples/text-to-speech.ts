import {
  loadModel,
  textToSpeech,
  unloadModel,
  TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM,
  TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM_CONFIG,
} from "@qvac/sdk";
import { writeFileSync, unlinkSync } from "fs";
import { spawnSync } from "child_process";
import { platform } from "os";

// Get eSpeakDataPath from command line arguments or use default
const eSpeakDataPath = process.argv[2];

console.log(`Using eSpeak data path: ${eSpeakDataPath}`);

if (!eSpeakDataPath) {
  console.error("eSpeakDataPath is required");
  process.exit(1);
}

try {
  const modelId = await loadModel({
    modelSrc: TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM,
    modelType: "tts",
    configSrc: TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM_CONFIG,
    eSpeakDataPath,
    modelConfig: {
      language: "en",
    },
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log(`Model loaded: ${modelId}`);

  // Test TTS
  console.log("🎵 Testing Text-to-Speech...");
  const result = textToSpeech({
    modelId,
    text: `QVAC SDK is the canonical entry point to QVAC. Written in TypeScript, it provides all QVAC capabilities through a unified interface while also abstracting away the complexity of running your application in a JS environment other than Bare. Supported JS environments include Bare, Node.js, Expo and Bun.`,
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  console.log(`TTS complete. Total bytes: ${audioBuffer.length}`);

  // Save and play audio
  console.log("💾 Saving audio to file...");
  createWav(audioBuffer, 22050, "tts-output.wav");
  console.log("✅ Audio saved to tts-output.wav");

  console.log("🔊 Playing audio...");
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length),
    audioData,
  ]);
  playAudio(wavBuffer);
  console.log("✅ Audio playback complete");

  // Unload the model
  await unloadModel({ modelId });
  console.log("Model unloaded");
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}

// Function to create WAV header for 16-bit PCM audio
function createWavHeader(
  dataLength: number,
  sampleRate: number = 22050,
): Buffer {
  const header = Buffer.alloc(44);

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);

  // fmt chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

// Function to convert Int16Array to Buffer
function int16ArrayToBuffer(int16Array: number[]): Buffer {
  const buffer = Buffer.alloc(int16Array.length * 2);
  for (let i = 0; i < int16Array.length; i++) {
    const value = int16Array[i] ?? 0;
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

// Function to create and save WAV file (similar to reference implementation)
export function createWav(
  audioBuffer: number[],
  sampleRate: number = 22050,
  filename: string = "output.wav",
): void {
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavHeader = createWavHeader(audioData.length, sampleRate);
  const wavFile = Buffer.concat([wavHeader, audioData]);

  writeFileSync(filename, wavFile);
  console.log(`WAV file saved as: ${filename}`);
}

// Function to play audio using system audio players
export function playAudio(audioBuffer: Buffer): void {
  const currentPlatform = platform();
  const tempFile = `/tmp/audio-${Date.now()}.wav`;

  // Write audio buffer to temporary file
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
    // Ignore cleanup errors
  }

  if (result.error) {
    throw new Error(`Audio player failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Audio player exited with code ${result.status}`);
  }
}
