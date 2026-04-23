import { writeFileSync } from "fs";
import { spawnSync } from "child_process";

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
 * Play a WAV buffer by streaming it into ffplay over stdin.
 *
 * ffplay ships with ffmpeg and is cross-platform (macOS/Linux/Windows), so
 * we avoid the old "write to /tmp then shell out to afplay/aplay/powershell"
 * dance — no temp files, no platform switch, no hardcoded /tmp path (which
 * doesn't exist on Windows). Requires ffplay on PATH.
 */
export function playAudio(audioBuffer: Buffer): void {
  const result = spawnSync(
    "ffplay",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-autoexit",
      "-nodisp",
      "-i",
      "pipe:0",
    ],
    {
      input: audioBuffer,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        "ffplay not found on PATH. Install ffmpeg (ffplay ships with it) and retry.",
      );
    }
    throw new Error(`ffplay failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffplay exited with code ${result.status}`);
  }
}
