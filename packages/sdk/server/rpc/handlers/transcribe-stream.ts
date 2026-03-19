import type {
  TranscribeStreamRequest,
  TranscribeStreamResponse,
} from "@/schemas";
import { transcribeStream } from "@/server/bare/ops/transcribe";
import type { Readable } from "bare-stream";

export async function* handleTranscribeStream(
  request: TranscribeStreamRequest,
  audioInputStream: Readable,
): AsyncGenerator<TranscribeStreamResponse> {
  for await (const text of transcribeStream(
    request.modelId,
    audioInputStream,
    request.prompt,
  )) {
    yield {
      type: "transcribeStream" as const,
      text,
    };
  }

  yield {
    type: "transcribeStream" as const,
    text: "",
    done: true,
  };
}
