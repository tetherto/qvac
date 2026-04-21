import { getModel } from "@/server/bare/registry/model-registry";
import {
  ttsRequestSchema,
  type TtsRequest,
  type TtsStats,
} from "@/schemas";
import { nowMs } from "@/profiling";
import { buildStreamResult, hasDefinedValues } from "@/profiling/model-execution";
import type { TtsResponse } from "@/server/bare/types/addon-responses";
import { TextToSpeechFailedError } from "@/utils/errors-server";
import {
  type TtsStreamChunk,
  type TtsOpYield,
  collectTtsStats,
} from "@/server/bare/utils/tts-stats";

type RunStreamModel = {
  runStream: (
    text: string,
    options?: { locale?: string; maxChunkScalars?: number },
  ) => Promise<{
    iterate: () => AsyncIterable<TtsStreamChunk>;
    stats?: { audioDurationMs?: number; totalSamples?: number };
  }>;
};

function hasRunStream(model: unknown): model is RunStreamModel {
  return (
    typeof model === "object" &&
    model !== null &&
    "runStream" in model &&
    typeof (model as RunStreamModel).runStream === "function"
  );
}

export async function* textToSpeech(
  params: TtsRequest,
): AsyncGenerator<TtsOpYield, { modelExecutionMs: number; stats?: TtsStats }> {
  const {
    modelId,
    inputType,
    text,
    stream,
    sentenceStream,
    sentenceStreamLocale,
    sentenceStreamMaxChunkScalars,
  } = ttsRequestSchema.parse(params);

  const model = getModel(modelId);
  const modelStart = nowMs();

  if (sentenceStream) {
    if (!hasRunStream(model)) {
      throw new TextToSpeechFailedError(
        "sentenceStream requires an ONNX TTS model with runStream (Supertonic)",
      );
    }

    const streamOpts =
      sentenceStreamLocale !== undefined || sentenceStreamMaxChunkScalars !== undefined
        ? {
            ...(sentenceStreamLocale !== undefined
              ? { locale: sentenceStreamLocale }
              : {}),
            ...(sentenceStreamMaxChunkScalars !== undefined
              ? { maxChunkScalars: sentenceStreamMaxChunkScalars }
              : {}),
          }
        : undefined;

    const response = await model.runStream(text, streamOpts);

    if (!stream) {
      let completeBuffer: number[] = [];
      for await (const data of response.iterate()) {
        if (data.outputArray != null) {
          completeBuffer = completeBuffer.concat(Array.from(data.outputArray));
        }
      }
      const modelExecutionMs = nowMs() - modelStart;
      const stats = collectTtsStats(response);
      yield { buffer: completeBuffer };
      return buildStreamResult(
        modelExecutionMs,
        hasDefinedValues(stats) ? stats : undefined,
      );
    }

    for await (const data of response.iterate()) {
      if (data.outputArray == null) continue;
      const buf = Array.from(data.outputArray);
      if (buf.length === 0) continue;
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

  const response = (await model.run({
    input: text,
    inputType,
  })) as unknown as TtsResponse;

  if (!stream) {
    let completeBuffer: number[] = [];

    for await (const data of response.iterate()) {
      completeBuffer = completeBuffer.concat(Array.from(data.outputArray));
    }

    const modelExecutionMs = nowMs() - modelStart;
    const stats: TtsStats = {
      ...(response.stats?.audioDurationMs !== undefined && {
        audioDuration: response.stats.audioDurationMs,
      }),
      ...(response.stats?.totalSamples !== undefined && {
        totalSamples: response.stats.totalSamples,
      }),
    };

    yield { buffer: completeBuffer };
    return buildStreamResult(
      modelExecutionMs,
      hasDefinedValues(stats) ? stats : undefined,
    );
  }

  for await (const data of response.iterate()) {
    yield { buffer: Array.from(data.outputArray) };
  }

  const modelExecutionMs = nowMs() - modelStart;
  const stats: TtsStats = {
    ...(response.stats?.audioDurationMs !== undefined && {
      audioDuration: response.stats.audioDurationMs,
    }),
    ...(response.stats?.totalSamples !== undefined && {
      totalSamples: response.stats.totalSamples,
    }),
  };

  return buildStreamResult(
    modelExecutionMs,
    hasDefinedValues(stats) ? stats : undefined,
  );
}
