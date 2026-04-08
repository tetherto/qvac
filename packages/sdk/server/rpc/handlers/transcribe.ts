import type { TranscribeRequest, TranscribeResponse } from "@/schemas";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleTranscribe(
  request: TranscribeRequest,
): AsyncGenerator<TranscribeResponse> {
  yield* dispatchPluginStream<TranscribeRequest, TranscribeResponse>(
    request.modelId,
    "transcribe",
    request,
  );
}
