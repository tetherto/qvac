import test from "brittle";
import fs from "bare-fs";
import path from "bare-path";
import process from "bare-process";
import {
  transcribeStream,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  type TranscribeStreamConversationSession,
} from "@qvac/bare-sdk";
import { loadResource, unloadAll } from "../_lib/resources.js";
import { decodeWavToMonoF32, f32ToLeBytes } from "../_lib/wav-pcm.js";

// bare-client duplex (createDuplexSession) shape: write speech + trailing
// silence to drive end-of-turn. Tolerant assertion since ASR isn't deterministic.
const SAMPLE_RATE = 16000;
const BYTES_PER_F32 = 4;
// cwd-relative: scripts run brittle-bare from the package root, and compiled JS
// lives in test/dist/ so import.meta wouldn't resolve to the source asset.
const FIXTURE = path.resolve(
  process.cwd(),
  "test/bare/e2e/assets/two-speakers-16k.wav",
);

test("bare-sdk e2e: duplex transcribeStream round-trip", async (t) => {
  t.teardown(unloadAll);

  const modelId = await loadResource("whisper", {
    modelSrc: WHISPER_TINY,
    modelType: "whisper",
    modelConfig: {
      vadModelSrc: VAD_SILERO_5_1_2,
      audio_format: "f32le",
      strategy: "greedy",
      language: "en",
      temperature: 0,
    },
  });

  const raw = fs.readFileSync(FIXTURE);
  if (typeof raw === "string") throw new Error("fixture read returned text; expected bytes");
  const decoded = decodeWavToMonoF32(
    new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
  );
  t.is(decoded.sampleRate, SAMPLE_RATE, "fixture must be 16 kHz");

  const speech = f32ToLeBytes(decoded.samplesMono);
  const silence = new Uint8Array(Math.floor(1.5 * SAMPLE_RATE) * BYTES_PER_F32);
  const chunkSize = Math.floor(0.1 * SAMPLE_RATE) * BYTES_PER_F32;

  const session = (await transcribeStream({
    modelId,
    emitVadEvents: true,
    endOfTurnSilenceMs: 600,
  })) as TranscribeStreamConversationSession;

  writeInChunks(session, speech, chunkSize);
  writeInChunks(session, silence, chunkSize);
  session.end();

  let transcript = "";
  let eventCount = 0;
  try {
    for await (const event of session) {
      eventCount++;
      const e = event as { type: string; text?: string };
      if (e.type === "text" && typeof e.text === "string") transcript += e.text;
    }
  } finally {
    try {
      session.destroy();
    } catch {
      // ignore destroy-after-iteration errors
    }
  }

  t.ok(eventCount > 0, `expected events over the duplex session, got ${eventCount}`);
  t.ok(
    transcript.trim().length > 0,
    `expected a non-empty transcript, got: "${transcript.trim()}"`,
  );
});

function writeInChunks(
  session: { write(audioChunk: Uint8Array): void },
  bytes: Uint8Array,
  chunkSize: number,
) {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    session.write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
}
