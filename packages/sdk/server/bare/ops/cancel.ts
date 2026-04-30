import { getModel } from "@/server/bare/registry/model-registry";
import {
  type CancelInferenceBaseParams,
  cancelInferenceBaseSchema,
} from "@/schemas";
import { ModelNotLoadedError } from "@/utils/errors-server";
import { noteCancelRequested } from "@/server/bare/plugins/llamacpp-completion/ops/kv-cache-state";

export async function cancel(params: CancelInferenceBaseParams) {
  const { modelId } = cancelInferenceBaseSchema.parse(params);
  const model = getModel(modelId);

  if (!model) {
    throw new ModelNotLoadedError(modelId);
  }

  // Must be recorded *before* `addon.cancel()` so the in-flight
  // `completion()` for this model sees the bumped counter when it
  // snapshots after `processModelResponse` returns. This is the signal
  // that tells `completion()` not to record a `savedCount` for the
  // kv-cache on a cancelled turn.
  noteCancelRequested(modelId);

  if (model.addon && model.addon.cancel) {
    await model.addon.cancel();
  }
}
