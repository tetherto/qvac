import type { AudioGenStreamRequest, AudioGenStreamResponse } from '@/schemas/audio-gen'
import { dispatchPluginStream } from '@/server/rpc/handlers/plugin-dispatch'

export async function* handleAudioGenStream(
  request: AudioGenStreamRequest
): AsyncGenerator<AudioGenStreamResponse> {
  yield* dispatchPluginStream<AudioGenStreamRequest, AudioGenStreamResponse>(
    request.modelId,
    'audioGenStream',
    request
  )
}
