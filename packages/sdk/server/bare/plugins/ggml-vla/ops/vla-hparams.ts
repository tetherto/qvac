import { getModel } from "@/server/bare/registry/model-registry";
import {
  type VlaHparamsRequest,
  type VlaHparamsResponse,
  vlaHparamsSchema,
} from "@/schemas";

interface VlaModelLike {
  hparams: unknown;
  backendName: string | null;
}

export function vlaGetHparams(
  request: VlaHparamsRequest,
): Promise<VlaHparamsResponse> {
  const model = getModel(request.modelId) as unknown as VlaModelLike;
  // Validate the addon-reported hparams against our schema so the wire
  // shape stays consistent even if the underlying addon changes.
  const parsed = vlaHparamsSchema.parse(model.hparams);
  return Promise.resolve({
    hparams: parsed,
    backendName: model.backendName ?? null,
  });
}
