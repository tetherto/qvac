import type { TtsRequest, TtsResponse } from "@/schemas";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleTextToSpeech(
  request: TtsRequest,
): AsyncGenerator<TtsResponse> {
  yield* dispatchPluginStream<TtsRequest, TtsResponse>(
    request.modelId,
    "textToSpeech",
    request,
  );
}
