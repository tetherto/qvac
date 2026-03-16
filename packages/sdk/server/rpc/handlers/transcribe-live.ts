import type {
  TranscribeLiveRequest,
  TranscribeLiveResponse,
} from "@/schemas";
import { transcribeLive } from "@/server/bare/ops/transcribe";
import type { Readable } from "bare-stream";

export async function* handleTranscribeLive(
  request: TranscribeLiveRequest,
  audioInputStream: Readable,
): AsyncGenerator<TranscribeLiveResponse> {
  for await (const text of transcribeLive(
    request.modelId,
    audioInputStream,
    request.prompt,
  )) {
    yield {
      type: "transcribeLive" as const,
      text,
    };
  }

  yield {
    type: "transcribeLive" as const,
    text: "",
    done: true,
  };
}
