/**
 * Minimal WAV (RIFF) decoder for the e2e test suite.
 *
 * Supports canonical PCM WAV: format code 1 (PCM), 16-bit signed, any channel
 * count and sample rate. Down-mixes to mono and converts to f32 in [-1, 1].
 * No node:* imports so it can run from both desktop and mobile executors.
 */

export interface DecodedPcm {
  sampleRate: number;
  numChannels: number;
  samplesMono: Float32Array;
}

function readUint32Le(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

function readUint16Le(view: DataView, offset: number) {
  return view.getUint16(offset, true);
}

function readAscii(view: DataView, offset: number, length: number) {
  let s = "";
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

export function decodeWavToMonoF32(bytes: Uint8Array): DecodedPcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("decodeWavToMonoF32: not a RIFF/WAVE file");
  }

  let offset = 12;
  let fmtFound = false;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = readUint32Le(view, offset + 4);
    const chunkBody = offset + 8;

    if (chunkId === "fmt ") {
      audioFormat = readUint16Le(view, chunkBody + 0);
      numChannels = readUint16Le(view, chunkBody + 2);
      sampleRate = readUint32Le(view, chunkBody + 4);
      bitsPerSample = readUint16Le(view, chunkBody + 14);
      fmtFound = true;
    } else if (chunkId === "data") {
      dataOffset = chunkBody;
      dataLength = chunkSize;
      break;
    }

    // Chunks are padded to even size per RIFF spec.
    offset = chunkBody + chunkSize + (chunkSize % 2);
  }

  if (!fmtFound) throw new Error("decodeWavToMonoF32: missing fmt chunk");
  if (dataOffset < 0) throw new Error("decodeWavToMonoF32: missing data chunk");
  if (audioFormat !== 1) {
    throw new Error(
      `decodeWavToMonoF32: unsupported audio format ${audioFormat} (only PCM=1)`,
    );
  }
  if (bitsPerSample !== 16) {
    throw new Error(
      `decodeWavToMonoF32: unsupported bit depth ${bitsPerSample} (only 16-bit)`,
    );
  }

  const totalInt16 = dataLength / 2;
  const numFrames = totalInt16 / numChannels;
  const samplesMono = new Float32Array(numFrames);

  const pcm = new DataView(
    bytes.buffer,
    bytes.byteOffset + dataOffset,
    dataLength,
  );
  for (let frame = 0; frame < numFrames; frame++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += pcm.getInt16((frame * numChannels + ch) * 2, true);
    }
    samplesMono[frame] = sum / numChannels / 32768;
  }

  return { sampleRate, numChannels, samplesMono };
}

/**
 * Pack a Float32Array as little-endian f32 bytes for transport over the
 * duplex transcribeStream session.
 */
export function f32ToLeBytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.byteLength);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(i * 4, samples[i] ?? 0, true);
  }
  return out;
}
