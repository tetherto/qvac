import type { ClassifyRequest, ClassifyResponse } from '../../schemas/classification'
import { dispatchPluginStream } from '../../handlers/plugin-dispatch'

export async function* handleClassify(request: ClassifyRequest): AsyncGenerator<ClassifyResponse> {
  yield* dispatchPluginStream<ClassifyRequest, ClassifyResponse>(
    request.modelId,
    'classify',
    request
  )
}
