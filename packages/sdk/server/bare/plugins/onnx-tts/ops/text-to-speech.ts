import { getModel } from "@/server/bare/registry/model-registry";
import { ttsRequestSchema, type TtsRequest, type TtsStats } from "@/schemas";
import { nowMs } from "@/profiling";
import { buildStreamResult, hasDefinedValues } from "@/profiling/model-execution";
import type { TtsResponse } from "@/server/bare/types/addon-responses";

export async function* textToSpeech(
  params: TtsRequest,
): AsyncGenerator<{ buffer: number[] }, { modelExecutionMs: number; stats?: TtsStats }> {
  const { modelId, inputType, text, stream } = ttsRequestSchema.parse(params);

  const model = getModel(modelId);

  const modelStart = nowMs();
  const response = (await model.run({ input: text, inputType })) as unknown as TtsResponse;

  if (!stream) {
    // Non-streaming mode: collect all chunks and return once
    let completeBuffer: number[] = [];

    for await (const data of response.iterate()) {
      completeBuffer = completeBuffer.concat(Array.from(data.outputArray));
    }

    const modelExecutionMs = nowMs() - modelStart;
    const stats: TtsStats = {
      ...(response.stats?.audioDurationMs !== undefined && { audioDuration: response.stats.audioDurationMs }),
      ...(response.stats?.totalSamples !== undefined && { totalSamples: response.stats.totalSamples }),
    };

    yield { buffer: completeBuffer };
    return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined);
  }

  // Streaming mode: yield chunks as they arrive
  for await (const data of response.iterate()) {
    yield { buffer: Array.from(data.outputArray) };
  }

  const modelExecutionMs = nowMs() - modelStart;
  const stats: TtsStats = {
    ...(response.stats?.audioDurationMs !== undefined && { audioDuration: response.stats.audioDurationMs }),
    ...(response.stats?.totalSamples !== undefined && { totalSamples: response.stats.totalSamples }),
  };

  return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined);
}
