import type {
  BciTranscribeStreamRequest,
  BciTranscribeStreamResponse,
} from "@/schemas";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleBciTranscribeStream(
  request: BciTranscribeStreamRequest,
  inputStream: AsyncIterable<Buffer>,
): AsyncGenerator<BciTranscribeStreamResponse> {
  yield* dispatchPluginStream<
    BciTranscribeStreamRequest,
    BciTranscribeStreamResponse
  >(request.modelId, "bciTranscribeStream", request, inputStream);
}
