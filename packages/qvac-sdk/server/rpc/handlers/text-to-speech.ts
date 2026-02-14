import type { TtsRequest, TtsResponse } from "@/schemas";
import { textToSpeech } from "@/server/bare/addons/onnx-tts";
import { TextToSpeechFailedError } from "@/utils/errors-server";

export async function* handleTextToSpeech(
  request: TtsRequest,
): AsyncGenerator<TtsResponse> {
  try {
    for await (const response of textToSpeech(request)) {
      yield response;
    }
  } catch (error) {
    if (error instanceof TextToSpeechFailedError) {
      throw error;
    }
    throw new TextToSpeechFailedError(
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}
