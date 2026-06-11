import type { BciTranscribeRequest, BciTranscribeResponse } from "@/schemas";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleBciTranscribe(
  request: BciTranscribeRequest,
): AsyncGenerator<BciTranscribeResponse> {
  yield* dispatchPluginStream<BciTranscribeRequest, BciTranscribeResponse>(
    request.modelId,
    "bciTranscribe",
    request,
  );
}
