import { getModel } from "@/server/bare/registry/model-registry";
import { type TranscribeParams } from "@/schemas";
import { transcribeFromStream } from "@/server/bare/utils/transcribe-from-stream";

export async function* transcribe(
  params: TranscribeParams,
): AsyncGenerator<string, void, void> {
  const model = getModel(params.modelId);

  yield* transcribeFromStream({
    model,
    params,
    audioFormat: "s16le",
    logPrefix: "Parakeet ",
  });
}
