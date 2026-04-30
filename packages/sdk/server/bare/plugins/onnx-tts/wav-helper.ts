import fs from "bare-fs";

const CHATTERBOX_SAMPLE_RATE = 24000;

export type ReadWavResult = { samples: Float32Array; sampleRate: number };

/**
 * Read a WAV file and return Float32Array of mono samples in [-1, 1].
 * Supports 16-bit PCM and 32-bit float; stereo is converted to mono (left channel).
 */
export function readWavAsFloat32(wavPath: string): ReadWavResult {
  const buf = fs.readFileSync(wavPath) as Buffer;
  if (buf.length < 44) throw new Error("WAV file too small");

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

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
    else if (chunkId === "data")
      dataChunk = { offset: offset + 8, size: chunkSize };

    offset += 8 + chunkSize;
    if (chunkSize % 2 === 1 && offset < buf.length) offset += 1;
  }

  if (!fmtChunk) throw new Error("WAV missing fmt chunk");
  if (!dataChunk) throw new Error("WAV missing data chunk");

  const fmtOff = fmtChunk.offset;
  if (fmtOff + 16 > buf.length) throw new Error("fmt chunk truncated");

  const audioFormat = view.getUint16(fmtOff, true);
  const numChannels = view.getUint16(fmtOff + 2, true);
  const sampleRate = view.getUint32(fmtOff + 4, true);
  const bitsPerSample = view.getUint16(fmtOff + 14, true);

  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(
      "Unsupported WAV audio format: " +
        audioFormat +
        " (only PCM=1 and IEEE_FLOAT=3 supported)",
    );
  }

  const dataOff = dataChunk.offset;
  const dataLen = Math.min(dataChunk.size, buf.length - dataOff);

  let samples: Float32Array;
  if (audioFormat === 1 && bitsPerSample === 16) {
    const bytesPerSample = 2;
    const numSamples = Math.floor(dataLen / bytesPerSample);
    const numFrames =
      numChannels === 1 ? numSamples : Math.floor(numSamples / numChannels);
    samples = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      const idx = dataOff + (numChannels === 1 ? i * 2 : i * numChannels * 2);
      if (idx + 2 > buf.length) break;
      const s = view.getInt16(idx, true);
      samples[i] = s / 32768;
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    const bytesPerSample = 4;
    const numSamples = Math.floor(dataLen / bytesPerSample);
    const numFrames =
      numChannels === 1 ? numSamples : Math.floor(numSamples / numChannels);
    samples = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      const idx = dataOff + (numChannels === 1 ? i * 4 : i * numChannels * 4);
      if (idx + 4 > buf.length) break;
      samples[i] = view.getFloat32(idx, true);
    }
  } else {
    throw new Error(
      "Unsupported WAV format: audioFormat=" +
        audioFormat +
        ", bitsPerSample=" +
        bitsPerSample,
    );
  }

  return { samples, sampleRate };
}

function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outputLen = Math.round(samples.length / ratio);
  const output = new Float32Array(outputLen);
  for (let i = 0; i < outputLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = srcIdx - lo;
    output[i] = samples[lo]! * (1 - frac) + samples[hi]! * frac;
  }
  return output;
}

/**
 * Load reference audio from a WAV path and return Float32Array at 24kHz for Chatterbox.
 */
export function loadReferenceAudioAt24k(wavPath: string): Float32Array {
  const { samples, sampleRate } = readWavAsFloat32(wavPath);
  if (sampleRate === CHATTERBOX_SAMPLE_RATE) return samples;
  return resampleLinear(samples, sampleRate, CHATTERBOX_SAMPLE_RATE);
}
