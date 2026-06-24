import type {
  TextToSpeechStreamRequest,
  TextToSpeechStreamResponse,
} from "@/schemas";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleTextToSpeechStream(
  request: TextToSpeechStreamRequest,
  inputStream: AsyncIterable<Buffer>,
): AsyncGenerator<TextToSpeechStreamResponse> {
  yield* dispatchPluginStream<
    TextToSpeechStreamRequest,
    TextToSpeechStreamResponse
  >(request.modelId, "textToSpeechStream", request, inputStream);
}
