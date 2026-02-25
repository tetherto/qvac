import { writeFileSync, unlinkSync } from "fs";
import { spawnSync } from "child_process";
import { platform } from "os";

/**
 * Create WAV header for 16-bit PCM audio
 */
export function createWavHeader(
  dataLength: number,
  sampleRate: number,
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

/**
 * Convert Int16Array to Buffer
 */
export function int16ArrayToBuffer(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(
      -32768,
      Math.min(32767, Math.round(samples[i] ?? 0)),
    );
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

/**
 * Create and save WAV file
 */
export function createWav(
  audioBuffer: number[],
  sampleRate: number,
  filename: string,
): void {
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavHeader = createWavHeader(audioData.length, sampleRate);
  const wavFile = Buffer.concat([wavHeader, audioData]);

  writeFileSync(filename, wavFile);
  console.log(`WAV file saved as: ${filename}`);
}

/**
 * Play audio using system audio players
 */
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
