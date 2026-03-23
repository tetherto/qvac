import type {
  TranscribeStreamRequest,
  TranscribeStreamResponse,
} from "@/schemas";
import { dispatchPluginDuplex } from "@/server/rpc/handlers/plugin-dispatch";
import type { Readable } from "bare-stream";

export async function* handleTranscribeStream(
  request: TranscribeStreamRequest,
  audioInputStream: Readable,
): AsyncGenerator<TranscribeStreamResponse> {
  yield* dispatchPluginDuplex<TranscribeStreamRequest, TranscribeStreamResponse>(
    request.modelId,
    "transcribeStream",
    request,
    audioInputStream,
  );
}
