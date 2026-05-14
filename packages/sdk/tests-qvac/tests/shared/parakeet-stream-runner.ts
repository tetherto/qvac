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
  source?: "whisper" | "parakeet";
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

    await writeInChunks(session, speech, chunkSize, chunkMs);
    await writeInChunks(session, silence, chunkSize, chunkMs);
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

/**
 * Same audio fixture / chunking as `runParakeetStreamHappy`, but
 * additionally asserts that ≥ 1 `endOfTurn` event surfaces. Designed
 * to be paired with the EOU parakeet checkpoint
 * (`PARAKEET_EOU_120M_V1_Q8_0`); CTC/TDT models will fail this
 * assertion because they don't emit `<EOU>` tokens.
 */
export async function runParakeetStreamEou(
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

    await writeInChunks(session, speech, chunkSize, chunkMs);
    await writeInChunks(session, silence, chunkSize, chunkMs);
    session.end();

    const events: CollectedEvent[] = [];
    for await (const event of session) {
      events.push(event as CollectedEvent);
    }

    return assertEou(events);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { passed: false, output: `parakeet eou stream failed: ${errorMsg}` };
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
    } as never)) as unknown as TranscribeStreamSession;
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

// Parakeet's `StreamSession` is designed for live audio and only
// emits segments when the feed is wall-clock-paced (see the addon's
// own `duplex-streaming.test.js` / `live-stream-simulation.test.js`,
// which sleep `setTimeout(chunkMs)` between chunks). Flooding the
// duplex RPC with the full clip synchronously results in zero
// segments coming back, so callers MUST `await` this helper and pass
// a non-zero `delayMs` for any test that expects transcript output.
// `delayMs = 0` is the fast-path used by the destroy-mid-utterance
// "first session", where we deliberately want to write a couple of
// chunks and yank the session before the engine ever produces text.
async function writeInChunks(
  session: { write(audioChunk: Uint8Array): void },
  bytes: Uint8Array,
  chunkSize: number,
  delayMs: number,
) {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    session.write(bytes.subarray(offset, end));
    if (delayMs > 0 && end < bytes.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Mid-utterance teardown: opens a duplex session, writes a couple of
 * audio chunks (no `end()` / no trailing silence), calls
 * `session.destroy()`, then opens a fresh session against the same
 * loaded model and runs a happy-path stream end-to-end.
 *
 * Locks down two invariants of the new parakeet `StreamSession`:
 *   1. `destroy()` mid-utterance does NOT hang the worker — the
 *      addon's input stream tear-down must propagate so the duplex
 *      handler exits cleanly.
 *   2. The model remains usable for subsequent sessions; the native
 *      `parakeet::StreamSession` is per-call and must not leave the
 *      addon in a wedged state after a forced shutdown.
 */
export async function runParakeetStreamDestroyMidUtterance(
  modelId: string,
  audioBytes: Uint8Array,
  params: ParakeetStreamParams,
): Promise<TestResult> {
  let firstSession: TranscribeStreamConversationSession | null = null;
  let secondSession: TranscribeStreamConversationSession | null = null;
  try {
    const decoded = decodeWavToMonoF32(audioBytes);
    if (decoded.sampleRate !== EXPECTED_SAMPLE_RATE) {
      return {
        passed: false,
        output: `Fixture sample rate ${decoded.sampleRate} != expected ${EXPECTED_SAMPLE_RATE}`,
      };
    }
    const chunkMs = params.chunkMs ?? 1000;
    const speech = f32ToS16LeBytes(decoded.samplesMono);
    const chunkSize =
      Math.floor((chunkMs / 1000) * EXPECTED_SAMPLE_RATE) *
      BYTES_PER_S16_SAMPLE;

    firstSession = await transcribeStream({
      modelId,
      parakeetStreamingConfig: { chunkMs },
    });

    // Write exactly 2 chunks, then yank the session WITHOUT calling
    // `end()` — this exercises the mid-utterance teardown path.
    const chunks = Math.min(2, Math.ceil(speech.length / chunkSize));
    for (let i = 0; i < chunks; i++) {
      const offset = i * chunkSize;
      const end = Math.min(offset + chunkSize, speech.length);
      firstSession.write(speech.subarray(offset, end));
    }
    firstSession.destroy();
    firstSession = null;

    // Recover with a fresh session — same modelId, full happy path.
    const trailingMs = params.trailingSilenceMs ?? 1500;
    const trailingSamples = Math.floor(
      (trailingMs / 1000) * EXPECTED_SAMPLE_RATE,
    );
    const silence = new Uint8Array(trailingSamples * BYTES_PER_S16_SAMPLE);

    secondSession = await transcribeStream({
      modelId,
      parakeetStreamingConfig: {
        chunkMs,
        ...(params.emitPartials !== undefined && {
          emitPartials: params.emitPartials,
        }),
      },
    });
    await writeInChunks(secondSession, speech, chunkSize, chunkMs);
    await writeInChunks(secondSession, silence, chunkSize, chunkMs);
    secondSession.end();

    const events: CollectedEvent[] = [];
    for await (const event of secondSession) {
      events.push(event as CollectedEvent);
    }
    return assertHappy(events);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      output: `parakeet destroy-then-recover failed: ${errorMsg}`,
    };
  } finally {
    try {
      firstSession?.destroy();
    } catch {
      // first session already destroyed in the success path
    }
    try {
      secondSession?.destroy();
    } catch {
      // already torn down by `for await` completion
    }
  }
}

/**
 * Consumer-side throw mid-iteration: opens a duplex session, drives
 * the stream, then throws from inside the `for await` body after the
 * first event surfaces. The iterator MUST unwind cleanly — no hung
 * worker, no leaked native `StreamSession`. After the throw, a fresh
 * session against the same model must complete normally, proving
 * that consumer-driven cancellation propagates through to the native
 * teardown path.
 */
export async function runParakeetStreamIteratorThrow(
  modelId: string,
  audioBytes: Uint8Array,
  params: ParakeetStreamParams,
): Promise<TestResult> {
  let throwingSession: TranscribeStreamConversationSession | null = null;
  let recoverySession: TranscribeStreamConversationSession | null = null;
  const sentinel = new Error("__test_consumer_threw__");
  try {
    const decoded = decodeWavToMonoF32(audioBytes);
    if (decoded.sampleRate !== EXPECTED_SAMPLE_RATE) {
      return {
        passed: false,
        output: `Fixture sample rate ${decoded.sampleRate} != expected ${EXPECTED_SAMPLE_RATE}`,
      };
    }
    const chunkMs = params.chunkMs ?? 1000;
    const trailingMs = params.trailingSilenceMs ?? 1500;
    const trailingSamples = Math.floor(
      (trailingMs / 1000) * EXPECTED_SAMPLE_RATE,
    );
    const speech = f32ToS16LeBytes(decoded.samplesMono);
    const silence = new Uint8Array(trailingSamples * BYTES_PER_S16_SAMPLE);
    const chunkSize =
      Math.floor((chunkMs / 1000) * EXPECTED_SAMPLE_RATE) *
      BYTES_PER_S16_SAMPLE;

    throwingSession = await transcribeStream({
      modelId,
      parakeetStreamingConfig: { chunkMs },
    });
    await writeInChunks(throwingSession, speech, chunkSize, chunkMs);
    await writeInChunks(throwingSession, silence, chunkSize, chunkMs);
    throwingSession.end();

    let caughtSentinel = false;
    try {
      for await (const _ of throwingSession) {
        throw sentinel;
      }
      return {
        passed: false,
        output: "expected consumer throw, but iterator completed without yielding",
      };
    } catch (err) {
      if (err !== sentinel) {
        return {
          passed: false,
          output: `consumer-side throw produced unexpected error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      caughtSentinel = true;
    }
    if (!caughtSentinel) {
      return {
        passed: false,
        output: "consumer-side sentinel error was not propagated",
      };
    }
    // The for-await sentinel throw is supposed to invoke the iterator's
    // async `return()`, which in turn tears down the native
    // `StreamSession`. On Node/Bare-desktop the unwind runs to
    // completion synchronously enough that the native session is fully
    // released before the next `transcribeStream({ modelId })` call. On
    // the Bare-RN bridge (iOS / Android) the iterator-return →
    // native-destroy chain crosses JSI and is best-effort: opening the
    // recovery session before the previous one is released leaves the
    // model wedged and the recovery session yields zero events. Real
    // SDK consumers that want to abandon mid-iteration should always
    // call `destroy()` explicitly — emulate that here so the test
    // exercises the recovery contract, not JSI return-propagation
    // timing.
    try {
      throwingSession.destroy();
    } catch {
      // session may already be torn down by the iterator unwind
    }
    throwingSession = null;

    // Recover: a brand new session against the same model must
    // complete normally. If the addon were wedged after the
    // consumer-side throw, this would hang or fail to load.
    recoverySession = await transcribeStream({
      modelId,
      parakeetStreamingConfig: {
        chunkMs,
        ...(params.emitPartials !== undefined && {
          emitPartials: params.emitPartials,
        }),
      },
    });
    await writeInChunks(recoverySession, speech, chunkSize, chunkMs);
    await writeInChunks(recoverySession, silence, chunkSize, chunkMs);
    recoverySession.end();

    const events: CollectedEvent[] = [];
    for await (const event of recoverySession) {
      events.push(event as CollectedEvent);
    }
    return assertHappy(events);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      output: `parakeet iterator-throw recovery failed: ${errorMsg}`,
    };
  } finally {
    try {
      throwingSession?.destroy();
    } catch {
      // session already torn down by sentinel throw / consumer exit
    }
    try {
      recoverySession?.destroy();
    } catch {
      // already torn down by `for await` completion
    }
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

function assertEou(events: CollectedEvent[]): TestResult {
  const counts = countByType(events);
  const summary = JSON.stringify(counts);

  if (!counts["text"]) {
    return {
      passed: false,
      output: `expected at least one text event, got: ${summary}`,
    };
  }
  if (!counts["endOfTurn"]) {
    return {
      passed: false,
      output: `expected at least one endOfTurn event from EOU model, got: ${summary}`,
    };
  }
  if (counts["vad"]) {
    return {
      passed: false,
      output: `parakeet must not emit standalone vad events, got: ${summary}`,
    };
  }
  // Per-event sanity: parakeet's EOU is token-driven; every parakeet
  // `endOfTurn` event must carry `source: "parakeet"` and MUST NOT
  // surface a `silenceDurationMs` field (that's the whisper variant
  // of the discriminated union).
  for (const ev of events) {
    if (ev.type !== "endOfTurn") continue;
    if (ev.source !== "parakeet") {
      return {
        passed: false,
        output: `parakeet endOfTurn must declare source="parakeet", got: ${JSON.stringify(ev)}`,
      };
    }
    if (ev.silenceDurationMs !== undefined) {
      return {
        passed: false,
        output: `parakeet endOfTurn must omit silenceDurationMs (whisper-only), got: ${JSON.stringify(ev)}`,
      };
    }
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
