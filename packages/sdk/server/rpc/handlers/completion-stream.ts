import type {
  CompletionStreamRequest,
  CompletionStreamResponse,
} from "@/schemas";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleCompletionStream(
  request: CompletionStreamRequest,
): AsyncGenerator<CompletionStreamResponse> {
  yield* dispatchPluginStream<
    CompletionStreamRequest,
    CompletionStreamResponse
  >(request.modelId, "completionStream", request);
}
