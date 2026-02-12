import type { TtsRequest, TtsResponse } from "@/schemas";
import { textToSpeech } from "@/server/bare/addons/onnx-tts";

export async function* handleTextToSpeech(
  request: TtsRequest,
): AsyncGenerator<TtsResponse> {
  const stream = textToSpeech(request);

  for await (const response of stream) {
    yield response;
  }
}
