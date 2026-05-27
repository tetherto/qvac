import {
  transcribeStream,
  type TranscribeSegment,
  type TranscribeStreamMetadataSession,
} from "@qvac/sdk";
import type { TestResult } from "@tetherto/qvac-test-suite";
import { decodeWavToMonoF32, f32ToLeBytes } from "./wav-pcm.js";

const EXPECTED_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4;

export interface MetadataStreamOptions {
  trailingSilenceMs?: number;
  chunkMs?: number;
}

// Fixture must be 16kHz mono 16-bit PCM WAV; the duplex session expects
// raw f32le frames at that rate.
export async function runMetadataStreamDuplex(
  modelId: string,
  audioBytes: Uint8Array,
  options: MetadataStreamOptions = {},
): Promise<TestResult> {
  let session: TranscribeStreamMetadataSession | null = null;
  try {
    const decoded = decodeWavToMonoF32(audioBytes);
    if (decoded.sampleRate !== EXPECTED_SAMPLE_RATE) {
      return {
        passed: false,
        output:
          `Fixture sample rate ${decoded.sampleRate} != expected ` +
          `${EXPECTED_SAMPLE_RATE}. Use a 16kHz mono WAV.`,
      };
    }

    const trailingMs = options.trailingSilenceMs ?? 1500;
    const chunkMs = options.chunkMs ?? 100;
    const trailingSamples = Math.floor(
      (trailingMs / 1000) * EXPECTED_SAMPLE_RATE,
    );

    const speech = f32ToLeBytes(decoded.samplesMono);
    const silence = new Uint8Array(trailingSamples * BYTES_PER_SAMPLE);
    const chunkSize =
      Math.floor((chunkMs / 1000) * EXPECTED_SAMPLE_RATE) * BYTES_PER_SAMPLE;

    session = await transcribeStream({ modelId, metadata: true });

    writeInChunks(session, speech, chunkSize);
    writeInChunks(session, silence, chunkSize);
    session.end();

    const segments: TranscribeSegment[] = [];
    for await (const segment of session) {
      segments.push(segment);
    }

    return validateSegments(segments);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { passed: false, output: `Metadata streaming failed: ${errorMsg}` };
  } finally {
    try {
      session?.destroy();
    } catch {
      // ignore destroy-after-iteration errors
    }
  }
}

function writeInChunks(
  session: { write(audioChunk: Uint8Array): void },
  bytes: Uint8Array,
  chunkSize: number,
) {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    session.write(bytes.subarray(offset, end));
  }
}

export function validateSegments(segments: unknown): TestResult {
  if (!Array.isArray(segments)) {
    return { passed: false, output: `Expected array, got ${typeof segments}` };
  }
  if (segments.length === 0) {
    return { passed: false, output: "Expected at least one segment" };
  }

  let prevStartMs = -Infinity;
  let prevId = -Infinity;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Partial<TranscribeSegment>;
    if (typeof seg !== "object" || seg === null) {
      return { passed: false, output: `Segment ${i}: not an object` };
    }
    if (typeof seg.text !== "string") {
      return { passed: false, output: `Segment ${i}: missing/invalid text` };
    }
    if (typeof seg.startMs !== "number" || !Number.isFinite(seg.startMs)) {
      return { passed: false, output: `Segment ${i}: missing/invalid startMs` };
    }
    if (typeof seg.endMs !== "number" || !Number.isFinite(seg.endMs)) {
      return { passed: false, output: `Segment ${i}: missing/invalid endMs` };
    }
    if (seg.endMs < seg.startMs) {
      return {
        passed: false,
        output: `Segment ${i}: endMs (${seg.endMs}) < startMs (${seg.startMs})`,
      };
    }
    if (typeof seg.append !== "boolean") {
      return { passed: false, output: `Segment ${i}: missing/invalid append` };
    }
    if (typeof seg.id !== "number" || !Number.isInteger(seg.id)) {
      return { passed: false, output: `Segment ${i}: missing/invalid id` };
    }
    if (seg.startMs < prevStartMs) {
      return {
        passed: false,
        output:
          `Segment ${i}: out-of-order startMs (${seg.startMs}) < ` +
          `previous startMs (${prevStartMs}). Segments must be emitted ` +
          `in audio-time order.`,
      };
    }
    if (seg.id < prevId) {
      return {
        passed: false,
        output:
          `Segment ${i}: out-of-order id (${seg.id}) < previous id ` +
          `(${prevId}). Whisper segment ids must be non-decreasing.`,
      };
    }
    prevStartMs = seg.startMs;
    prevId = seg.id;
  }

  return {
    passed: true,
    output:
      `Validated ${segments.length} segment(s): shape OK and emitted in ` +
      `non-decreasing audio-time order.`,
  };
}
