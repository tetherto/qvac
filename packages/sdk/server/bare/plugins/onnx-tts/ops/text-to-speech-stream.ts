import { getModel } from "@/server/bare/registry/model-registry";
import {
  textToSpeechStreamRequestSchema,
  type TextToSpeechStreamRequest,
  type TtsStats,
} from "@/schemas";
import { nowMs } from "@/profiling";
import { buildStreamResult, hasDefinedValues } from "@/profiling/model-execution";
import { TextToSpeechFailedError } from "@/utils/errors-server";

type TtsStreamChunk = {
  outputArray: ArrayLike<number>;
  chunkIndex?: number;
  sentenceChunk?: string;
};

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

type TtsOpYield = {
  buffer: number[];
  chunkIndex?: number;
  sentenceChunk?: string;
};

function collectTtsStats(response: {
  stats?: { audioDurationMs?: number; totalSamples?: number };
}): TtsStats {
  return {
    ...(response.stats?.audioDurationMs !== undefined && {
      audioDuration: response.stats.audioDurationMs,
    }),
    ...(response.stats?.totalSamples !== undefined && {
      totalSamples: response.stats.totalSamples,
    }),
  };
}

async function* buffersToUtf8Fragments(
  inputStream: AsyncIterable<Buffer>,
): AsyncGenerator<string, void, unknown> {
  for await (const buf of inputStream) {
    const s = buf.toString("utf8");
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
    throw new TextToSpeechFailedError(
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
