import { writeFileSync, unlinkSync } from "fs";
import { spawn, spawnSync } from "child_process";
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
/**
 * Play one mono s16le PCM chunk (as a minimal WAV) and wait for the player to finish.
 * Chunks are played sequentially when awaited in order — suitable for streaming TTS output.
 */
export function playPcmInt16Chunk(
  samples: number[],
  sampleRate: number,
): Promise<void> {
  if (samples.length === 0) {
    return Promise.resolve();
  }

  const audioData = int16ArrayToBuffer(samples);
  const wavHeader = createWavHeader(audioData.length, sampleRate);
  const wavFile = Buffer.concat([wavHeader, audioData]);
  const tempFile = `/tmp/qvac-tts-chunk-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`;
  writeFileSync(tempFile, wavFile);

  const currentPlatform = platform();
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

  return new Promise(function (resolve, reject) {
    const proc = spawn(audioPlayer, args, { stdio: "ignore" });
    proc.on("error", function (err) {
      try {
        unlinkSync(tempFile);
      } catch {
        // ignore
      }
      reject(err);
    });
    proc.on("close", function (code) {
      try {
        unlinkSync(tempFile);
      } catch {
        // ignore
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Audio player exited with code ${code}`));
      }
    });
  });
}

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
