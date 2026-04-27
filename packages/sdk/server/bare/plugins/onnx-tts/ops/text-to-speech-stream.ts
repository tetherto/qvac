import { getModel } from "@/server/bare/registry/model-registry";
import {
  textToSpeechStreamRequestSchema,
  type TextToSpeechStreamRequest,
  type TtsStats,
} from "@/schemas";
import { nowMs } from "@/profiling";
import { buildStreamResult, hasDefinedValues } from "@/profiling/model-execution";
import { TextToSpeechStreamFailedError } from "@/utils/errors-server";
import {
  type TtsStreamChunk,
  type TtsOpYield,
  collectTtsStats,
} from "@/server/bare/utils/tts-stats";

type RunStreamingModel = {
  runStreaming: (
    textStream: AsyncIterable<string>,
    options?: Record<string, unknown>,
  ) => Promise<{
    iterate: () => AsyncIterable<TtsStreamChunk>;
    stats?: { audioDurationMs?: number; totalSamples?: number };
  }>;
};

function hasRunStreaming(model: unknown): model is RunStreamingModel {
  return (
    typeof model === "object" &&
    model !== null &&
    "runStreaming" in model &&
    typeof (model as RunStreamingModel).runStreaming === "function"
  );
}

// Callers (e.g. LLM token deltas) may write raw Buffer chunks whose
// boundaries split a multi-byte UTF-8 codepoint. A naive `buf.toString("utf8")`
// per chunk emits U+FFFD at every split point and silently corrupts CJK,
// emoji, accented scripts, etc. before they reach the tokenizer. Keep a
// tail-buffer of at most 3 bytes spanning an incomplete trailing codepoint
// and decode only the complete-codepoint prefix of each combined chunk.
function findLastCompleteUtf8End(buf: Buffer): number {
  const len = buf.length;
  // A UTF-8 codepoint is at most 4 bytes, so a split can only dangle in
  // the last 3 bytes. Scan backwards to find the most recent leading byte.
  for (let i = len - 1; i >= 0 && i >= len - 3; i--) {
    const b = buf[i] as number;
    if ((b & 0x80) === 0) {
      // ASCII byte: everything up to and including i is complete.
      return i + 1;
    }
    if ((b & 0xc0) === 0xc0) {
      // Leading byte of a multi-byte sequence.
      let expected: number;
      if ((b & 0xe0) === 0xc0) expected = 2;
      else if ((b & 0xf0) === 0xe0) expected = 3;
      else if ((b & 0xf8) === 0xf0) expected = 4;
      else return len; // Invalid leader; let toString emit U+FFFD.
      return i + expected <= len ? len : i;
    }
  }
  return len;
}

async function* buffersToUtf8Fragments(
  inputStream: AsyncIterable<Buffer>,
): AsyncGenerator<string, void, unknown> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const buf of inputStream) {
    const combined =
      pending.length === 0 ? buf : Buffer.concat([pending, buf]);
    const completeEnd = findLastCompleteUtf8End(combined);
    if (completeEnd > 0) {
      const s = combined.subarray(0, completeEnd).toString("utf8");
      if (s.length > 0) {
        yield s;
      }
    }
    pending =
      completeEnd < combined.length
        ? Buffer.from(combined.subarray(completeEnd))
        : Buffer.alloc(0);
  }
  if (pending.length > 0) {
    // Stream ended with a dangling partial codepoint — flush as-is so the
    // tokenizer sees the replacement character rather than silently dropping
    // the final byte(s).
    const s = pending.toString("utf8");
    if (s.length > 0) {
      yield s;
    }
  }
}

function buildRunStreamingOptions(request: TextToSpeechStreamRequest) {
  const o: Record<string, unknown> = {};
  if (request.accumulateSentences !== undefined) {
    o["accumulateSentences"] = request.accumulateSentences;
  }
  if (request.sentenceDelimiterPreset !== undefined) {
    o["sentenceDelimiterPreset"] = request.sentenceDelimiterPreset;
  }
  if (request.maxBufferScalars !== undefined) {
    o["maxBufferScalars"] = request.maxBufferScalars;
  }
  if (request.flushAfterMs !== undefined) {
    o["flushAfterMs"] = request.flushAfterMs;
  }
  return o;
}

export async function* textToSpeechStream(
  params: TextToSpeechStreamRequest,
  inputStream: AsyncIterable<Buffer>,
): AsyncGenerator<
  TtsOpYield,
  { modelExecutionMs: number; stats?: TtsStats },
  unknown
> {
  const request = textToSpeechStreamRequestSchema.parse(params);

  const model = getModel(request.modelId);
  const modelStart = nowMs();

  if (!hasRunStreaming(model)) {
    throw new TextToSpeechStreamFailedError(
      "textToSpeechStream requires an ONNX TTS model with runStreaming",
    );
  }

  const textSource = buffersToUtf8Fragments(inputStream);
  const streamOpts = buildRunStreamingOptions(request);
  const response = await model.runStreaming(
    textSource,
    Object.keys(streamOpts).length > 0 ? streamOpts : undefined,
  );

  for await (const data of response.iterate()) {
    if (data.outputArray == null) {
      continue;
    }
    const buf = Array.from(data.outputArray);
    if (buf.length === 0) {
      continue;
    }
    yield {
      buffer: buf,
      ...(data.chunkIndex !== undefined ? { chunkIndex: data.chunkIndex } : {}),
      ...(typeof data.sentenceChunk === "string" && data.sentenceChunk.length > 0
        ? { sentenceChunk: data.sentenceChunk }
        : {}),
    };
  }

  const modelExecutionMs = nowMs() - modelStart;
  const stats = collectTtsStats(response);
  return buildStreamResult(
    modelExecutionMs,
    hasDefinedValues(stats) ? stats : undefined,
  );
}
