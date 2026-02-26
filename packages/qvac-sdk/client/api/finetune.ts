import { send } from "@/client/rpc/rpc-client";
import {
  type FinetuneParams,
  type FinetuneRequest,
  type FinetuneStatus,
  type PauseFinetuneParams,
  type ResumeFinetuneParams,
} from "@/schemas";
import { InvalidResponseError } from "@/utils/errors-client";
import { cancel } from "./cancel";

export interface FinetuneHandle {
  await(): Promise<{ status: FinetuneStatus }>;
}

/**
 * Starts LoRA finetuning on a loaded LLM model.
 *
 * For a clearer pause/resume flow, call `pause({ modelId })` and
 * `resume({ modelId })`. Calling `finetune({ modelId })` is also supported for resuming.
 */
export function finetune(params: FinetuneParams): Promise<FinetuneHandle> {
  const request: FinetuneRequest = {
    type: "finetune",
    ...params,
  };

  const resultPromise = send(request).then((response) => {
    if (response.type !== "finetune") {
      throw new InvalidResponseError("finetune");
    }

    return { status: response.status };
  });

  resultPromise.catch(() => {});

  return Promise.resolve({
    await: function () {
      return resultPromise;
    },
  });
}

/**
 * Pauses an active finetuning run for a model.
 */
export async function pause(params: PauseFinetuneParams) {
  await cancel({
    operation: "inference",
    modelId: params.modelId,
  });
}

/**
 * Resumes a previously paused finetuning run for a model.
 */
export function resume(params: ResumeFinetuneParams): Promise<FinetuneHandle> {
  return finetune({ modelId: params.modelId });
}
