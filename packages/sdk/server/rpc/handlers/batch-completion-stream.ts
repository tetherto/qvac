import type { BatchCompletionStreamRequest, BatchCompletionStreamResponse } from '@/schemas'
import { dispatchPluginStream } from '@/server/rpc/handlers/plugin-dispatch'

export async function* handleBatchCompletionStream(request: BatchCompletionStreamRequest) {
  yield* dispatchPluginStream<BatchCompletionStreamRequest, BatchCompletionStreamResponse>(
    request.modelId,
    'batchCompletionStream',
    request
  )
}
