import type { TranslateRequest, TranslateResponse } from '../../schemas'
import { dispatchPluginStream } from '../../handlers/plugin-dispatch'

export async function* handleTranslate(
  request: TranslateRequest
): AsyncGenerator<TranslateResponse> {
  yield* dispatchPluginStream<TranslateRequest, TranslateResponse>(
    request.modelId,
    'translate',
    request
  )
}
