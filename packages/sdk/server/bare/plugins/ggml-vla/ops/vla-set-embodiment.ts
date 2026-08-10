import { getModel } from '@/server/bare/registry/model-registry'
import {
  type VlaEmbodimentSelector,
  type VlaSetEmbodimentRequest,
  type VlaSetEmbodimentResponse,
  vlaHparamsSchema
} from '@/schemas'

interface VlaModelLike {
  setEmbodiment(embodiment: VlaEmbodimentSelector): Promise<unknown>
}

export async function vlaSetEmbodiment(
  request: VlaSetEmbodimentRequest
): Promise<VlaSetEmbodimentResponse> {
  const model = getModel(request.modelId) as unknown as VlaModelLike
  const hparams = await model.setEmbodiment(request.embodiment)
  // Validate the addon-reported hparams against our schema so the wire
  // shape stays consistent even if the underlying addon changes.
  return { hparams: vlaHparamsSchema.parse(hparams) }
}
