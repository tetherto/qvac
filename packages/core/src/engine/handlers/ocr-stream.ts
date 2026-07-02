import type { OCRStreamRequest, OCRStreamResponse } from '../../schemas'
import { dispatchPluginStream } from './plugin-dispatch'

export async function* handleOCRStream(
  request: OCRStreamRequest
): AsyncGenerator<OCRStreamResponse> {
  yield* dispatchPluginStream<OCRStreamRequest, OCRStreamResponse>(
    request.modelId,
    'ocrStream',
    request
  )
}
