import type { FinetuneProgressResponse, FinetuneRequest, FinetuneResult } from '../schemas'
import { dispatchPluginReply } from './plugin-dispatch'
import { startFinetune } from '../plugins/builtin/llamacpp-completion/ops/finetune'

export async function handleFinetune(
  request: FinetuneRequest,
  progressCallback?: (update: FinetuneProgressResponse) => void
): Promise<FinetuneResult> {
  if (
    progressCallback &&
    (request.operation === 'start' ||
      request.operation === 'resume' ||
      request.operation === undefined)
  ) {
    return startFinetune(request, (progress) => {
      const update: FinetuneProgressResponse = {
        type: 'finetune:progress',
        modelId: request.modelId,
        ...progress
      }
      progressCallback(update)
    })
  }

  return dispatchPluginReply<FinetuneRequest, FinetuneResult>(request.modelId, 'finetune', request)
}
