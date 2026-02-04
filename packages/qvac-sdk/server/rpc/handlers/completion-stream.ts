import type {
  CompletionStreamRequest,
  CompletionStreamResponse,
  CompletionStats,
  ToolCall,
} from "@/schemas";
import { completion } from "@/server/bare/addons/llamacpp-completion";

export async function* handleCompletionStream(
  request: CompletionStreamRequest,
): AsyncGenerator<CompletionStreamResponse> {
  const filteredHistory = request.history.map(
    ({ role, content, attachments }) => ({
      role,
      content,
      attachments: attachments ?? [],
    }),
  );

  const stream = completion({
    history: filteredHistory,
    modelId: request.modelId,
    kvCache: request.kvCache,
    ...(request.tools && { tools: request.tools }),
  });
  let stats: CompletionStats | undefined;
  let toolCalls: ToolCall[] = [];
  let done = false;
  let buffer = "";

  while (!done) {
    const result = await stream.next();

    if (result.done) {
      stats = result.value.stats;
      toolCalls = result.value.toolCalls;
      done = true;
    } else {
      if (request.stream) {
        yield {
          type: "completionStream" as const,
          token: result.value.token,
          toolCallEvent: result.value.toolCallEvent,
        };
      } else {
        buffer += result.value.token;
      }
    }
  }

  yield {
    type: "completionStream",
    token: request.stream ? "" : buffer,
    done: true,
    stats,
    toolCalls,
  };
}
