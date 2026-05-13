/**
 * Shared runner for parakeet duplex `transcribeStream` e2e tests.
 *
 * Decodes a 16 kHz mono WAV fixture, repacks it as the s16le PCM the
 * parakeet engine expects, drives the duplex RPC chunk-by-chunk, and
 * collects `text` / `endOfTurn` events from the conversation session.
 */
import {
  transcribeStream,
  type TranscribeStreamConversationSession,
  type TranscribeStreamSession,
} from "@qvac/sdk";
import type { TestResult } from "@tetherto/qvac-test-suite";
import { decodeWavToMonoF32 } from "./wav-pcm.js";

export interface ParakeetStreamParams {
  chunkMs?: number;
  emitPartials?: boolean;
  trailingSilenceMs?: number;
}

interface CollectedEvent {
  type: string;
  text?: string;
  silenceDurationMs?: number;
}

const EXPECTED_SAMPLE_RATE = 16000;
const BYTES_PER_S16_SAMPLE = 2;

export async function runParakeetStreamHappy(
  modelId: string,
  audioBytes: Uint8Array,
  params: ParakeetStreamParams,
): Promise<TestResult> {
  let session: TranscribeStreamConversationSession | null = null;
  try {
    const decoded = decodeWavToMonoF32(audioBytes);
    if (decoded.sampleRate !== EXPECTED_SAMPLE_RATE) {
      return {
        passed: false,
        output: `Fixture sample rate ${decoded.sampleRate} != expected ${EXPECTED_SAMPLE_RATE}`,
      };
    }

    const trailingMs = params.trailingSilenceMs ?? 1500;
    const chunkMs = params.chunkMs ?? 1000;
    const trailingSamples = Math.floor(
      (trailingMs / 1000) * EXPECTED_SAMPLE_RATE,
    );

    const speech = f32ToS16LeBytes(decoded.samplesMono);
    const silence = new Uint8Array(trailingSamples * BYTES_PER_S16_SAMPLE);
    const chunkSize =
      Math.floor((chunkMs / 1000) * EXPECTED_SAMPLE_RATE) *
      BYTES_PER_S16_SAMPLE;

    session = await transcribeStream({
      modelId,
      parakeetStreamingConfig: {
        chunkMs,
        ...(params.emitPartials !== undefined && {
          emitPartials: params.emitPartials,
        }),
      },
    });

    writeInChunks(session, speech, chunkSize);
    writeInChunks(session, silence, chunkSize);
    session.end();

    const events: CollectedEvent[] = [];
    for await (const event of session) {
      events.push(event as CollectedEvent);
    }

    return assertHappy(events);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { passed: false, output: `parakeet stream failed: ${errorMsg}` };
  } finally {
    try {
      session?.destroy();
    } catch {
      // Ignore destroy-after-iteration errors; the session may already be torn down.
    }
  }
}

export async function runParakeetStreamMetadataRejected(
  modelId: string,
): Promise<TestResult> {
  let session: TranscribeStreamSession | null = null;
  try {
    session = (await transcribeStream({
      modelId,
      metadata: true,
      parakeetStreamingConfig: { chunkMs: 1000 },
    } as never)) as TranscribeStreamSession;
    session.end();

    let receivedAny = false;
    for await (const _ of session) {
      receivedAny = true;
      break;
    }
    return {
      passed: false,
      output: receivedAny
        ? "expected parakeet to reject metadata: true; received an event instead"
        : "expected parakeet to reject metadata: true; iteration completed silently",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/metadata/i.test(msg) && /parakeet/i.test(msg)) {
      return { passed: true, output: msg };
    }
    return {
      passed: false,
      output: `unexpected error message: ${msg}`,
    };
  } finally {
    try {
      session?.destroy();
    } catch {
      // Ignore destroy-after-iteration errors; the session may already be torn down.
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

function f32ToS16LeBytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * BYTES_PER_S16_SAMPLE);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = Math.round(clamped * 32767);
    view.setInt16(i * 2, int16, true);
  }
  return out;
}

function assertHappy(events: CollectedEvent[]): TestResult {
  const counts = countByType(events);
  const summary = JSON.stringify(counts);

  if (!counts["text"]) {
    return {
      passed: false,
      output: `expected at least one text event, got: ${summary}`,
    };
  }
  if (counts["vad"]) {
    return {
      passed: false,
      output: `parakeet must not emit standalone vad events, got: ${summary}`,
    };
  }
  return { passed: true, output: summary };
}

function countByType(events: CollectedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  return counts;
}
