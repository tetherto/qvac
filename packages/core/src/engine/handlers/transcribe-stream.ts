import type { TranscribeStreamRequest, TranscribeStreamResponse } from '../../schemas'
import { dispatchPluginStream } from '../../handlers/plugin-dispatch'

export async function* handleTranscribeStream(
  request: TranscribeStreamRequest,
  inputStream: AsyncIterable<Buffer>
): AsyncGenerator<TranscribeStreamResponse> {
  yield* dispatchPluginStream<TranscribeStreamRequest, TranscribeStreamResponse>(
    request.modelId,
    'transcribeStream',
    request,
    inputStream
  )
}
