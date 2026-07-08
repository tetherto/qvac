import type { VideoStreamRequest, VideoStreamResponse } from '../../schemas/sdcpp-config'
import { dispatchPluginStream } from '../../handlers/plugin-dispatch'

export async function* handleVideoStream(
  request: VideoStreamRequest
): AsyncGenerator<VideoStreamResponse> {
  yield* dispatchPluginStream<VideoStreamRequest, VideoStreamResponse>(
    request.modelId,
    'videoStream',
    request
  )
}
