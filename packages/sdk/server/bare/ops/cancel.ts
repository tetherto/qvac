import { getModel } from "@/server/bare/registry/model-registry";
import {
  type CancelInferenceBaseParams,
  cancelInferenceBaseSchema,
} from "@/schemas";
import { ModelNotLoadedError } from "@/utils/errors-server";

interface CancelOptions extends CancelInferenceBaseParams {
  reset?: boolean | undefined;
}

export async function cancel(params: CancelOptions) {
  const { modelId } = cancelInferenceBaseSchema.parse(params);
  const model = getModel(modelId);

  if (!model) {
    throw new ModelNotLoadedError(modelId);
  }

  if (params.reset) {
    // Hard cancel — clears checkpoints, cannot resume
    if (model.addon && model.addon.cancel) {
      await model.addon.cancel();
    }
  } else {
    // Pause — saves checkpoint, can resume later
    const pausable = model as { pause?: () => Promise<void> };
    if (typeof pausable.pause === "function") {
      await pausable.pause();
    } else if (model.addon && model.addon.cancel) {
      await model.addon.cancel();
    }
  }
}
