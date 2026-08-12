import type { WorldSceneStreamRequest, WorldSceneStreamResponse } from '@/schemas/sdcpp-config'
import { dispatchPluginStream } from '@/server/rpc/handlers/plugin-dispatch'

export async function* handleWorldCreateScene(
  request: WorldSceneStreamRequest
): AsyncGenerator<WorldSceneStreamResponse> {
  yield* dispatchPluginStream<WorldSceneStreamRequest, WorldSceneStreamResponse>(
    request.modelId,
    'worldCreateScene',
    request
  )
}
