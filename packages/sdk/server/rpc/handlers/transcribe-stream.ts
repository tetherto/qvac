import type {
  TranscribeStreamRequest,
  TranscribeStreamResponse,
} from "@/schemas";
import { dispatchPluginDuplex } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleTranscribeStream(
  request: TranscribeStreamRequest,
  audioInputStream: AsyncIterable<Buffer>,
): AsyncGenerator<TranscribeStreamResponse> {
  yield* dispatchPluginDuplex<TranscribeStreamRequest, TranscribeStreamResponse>(
    request.modelId,
    "transcribeStream",
    request,
    audioInputStream,
  );
}

