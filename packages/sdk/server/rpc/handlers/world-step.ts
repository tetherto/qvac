import type { WorldStepStreamRequest, WorldStepStreamResponse } from '@/schemas/sdcpp-config'
import { dispatchPluginStream } from '@/server/rpc/handlers/plugin-dispatch'

export async function* handleWorldStep(
  request: WorldStepStreamRequest
): AsyncGenerator<WorldStepStreamResponse> {
  yield* dispatchPluginStream<WorldStepStreamRequest, WorldStepStreamResponse>(
    request.modelId,
    'worldStep',
    request
  )
}
