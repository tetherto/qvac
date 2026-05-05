import {
  transcribeStream,
  type TranscribeStreamConversationSession,
  type TranscribeStreamSession,
} from "@qvac/sdk";
import type { TestResult } from "@tetherto/qvac-test-suite";
import { decodeWavToMonoF32, f32ToLeBytes } from "./wav-pcm.js";

export interface TranscribeStreamEventsParams {
  emitVadEvents: boolean;
  endOfTurnSilenceMs?: number;
  trailingSilenceMs?: number;
  chunkMs?: number;
}

interface CollectedEvent {
  type: string;
  text?: string;
  speaking?: boolean;
  probability?: number;
  silenceDurationMs?: number;
}

const EXPECTED_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4;

/**
 * Drives `transcribeStream` end-to-end using a WAV fixture. Decodes the WAV
 * to f32le mono, streams chunks plus a trailing silence pad to trigger
 * end-of-turn detection, and asserts the collected event stream matches the
 * caller's expectation.
 */
export async function runTranscribeStreamEventsTest(
  modelId: string,
  audioBytes: Uint8Array,
  params: TranscribeStreamEventsParams,
  mode: "events-emitted" | "events-disabled",
): Promise<TestResult> {
  let session:
    | TranscribeStreamConversationSession
    | TranscribeStreamSession
    | null = null;
  try {
    const decoded = decodeWavToMonoF32(audioBytes);
    if (decoded.sampleRate !== EXPECTED_SAMPLE_RATE) {
      return {
        passed: false,
        output: `Fixture sample rate ${decoded.sampleRate} != expected ${EXPECTED_SAMPLE_RATE}`,
      };
    }

    const trailingMs = params.trailingSilenceMs ?? 1500;
    const chunkMs = params.chunkMs ?? 100;
    const trailingSamples = Math.floor(
      (trailingMs / 1000) * EXPECTED_SAMPLE_RATE,
    );

    const speech = f32ToLeBytes(decoded.samplesMono);
    const silence = new Uint8Array(trailingSamples * BYTES_PER_SAMPLE);
    const chunkSize =
      Math.floor((chunkMs / 1000) * EXPECTED_SAMPLE_RATE) * BYTES_PER_SAMPLE;

    session = params.emitVadEvents
      ? await transcribeStream({
          modelId,
          emitVadEvents: true,
          ...(params.endOfTurnSilenceMs !== undefined && {
            endOfTurnSilenceMs: params.endOfTurnSilenceMs,
          }),
        })
      : await transcribeStream({
          modelId,
          ...(params.endOfTurnSilenceMs !== undefined && {
            endOfTurnSilenceMs: params.endOfTurnSilenceMs,
          }),
        });

    writeInChunks(session, speech, chunkSize);
    writeInChunks(session, silence, chunkSize);
    session.end();

    const events: CollectedEvent[] = [];
    if (params.emitVadEvents) {
      const conv = session as TranscribeStreamConversationSession;
      for await (const event of conv) {
        events.push(event as CollectedEvent);
      }
    } else {
      const plain = session as TranscribeStreamSession;
      for await (const text of plain) {
        events.push({ type: "text", text });
      }
    }

    return assertEvents(events, mode);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { passed: false, output: `transcribeStream failed: ${errorMsg}` };
  } finally {
    try {
      session?.destroy();
    } catch {
      // ignore destroy-after-iteration errors
    }
  }
}

function writeInChunks(
  session: { write(audioChunk: Buffer): void },
  bytes: Uint8Array,
  chunkSize: number,
) {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    const slice = bytes.subarray(offset, end);
    session.write(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
  }
}

function assertEvents(
  events: CollectedEvent[],
  mode: "events-emitted" | "events-disabled",
): TestResult {
  const counts = countByType(events);
  const summary = JSON.stringify(counts);

  if (mode === "events-disabled") {
    if (counts["vad"] || counts["endOfTurn"]) {
      return {
        passed: false,
        output: `emitVadEvents=false but events were emitted: ${summary}`,
      };
    }
    if (!counts["text"]) {
      return {
        passed: false,
        output: `expected at least one text event, got: ${summary}`,
      };
    }
    return { passed: true, output: summary };
  }

  if (!counts["vad"]) {
    return {
      passed: false,
      output: `expected at least one vad event, got: ${summary}`,
    };
  }
  if (!counts["endOfTurn"]) {
    return {
      passed: false,
      output: `expected at least one endOfTurn event, got: ${summary}`,
    };
  }
  if (!counts["text"]) {
    return {
      passed: false,
      output: `expected at least one text event alongside events, got: ${summary}`,
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
