import type { ModelAdapter } from '@qvac/agents'
import type { SdkRuntimePort } from './sdk-runtime-port.ts'

export function createSdkModelAdapter(sdk: SdkRuntimePort): ModelAdapter {
  const requestIds = new Map<string, string>()

  return {
    async *stream(request) {
      const loaded = await sdk.loadModel({
        model: request.model,
        traceId: request.operationId
      })
      const completion = sdk.completion({
        requestId: request.operationId,
        traceId: request.operationId,
        modelId: loaded.modelId,
        messages: request.messages,
        signal: request.signal
      })
      requestIds.set(request.operationId, completion.requestId)
      try {
        for await (const event of completion.events) {
          if (event.type === 'content-delta' || event.type === 'contentDelta') {
            yield { type: 'content', text: event.text }
          }
        }
      } finally {
        requestIds.delete(request.operationId)
      }
    },
    async cancel(operationId) {
      await sdk.cancel({ requestId: requestIds.get(operationId) ?? operationId })
    }
  }
}
