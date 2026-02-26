import {
  getModel,
  getModelConfig,
} from "@/server/bare/registry/model-registry";
import {
  finetuneParamsSchema,
  finetuneStatusSchema,
  type FinetuneParams,
  type FinetuningOptions,
} from "@/schemas";
import { CompletionFailedError } from "@/utils/errors-server";

interface FinetuneHandle {
  await(): Promise<{ status: string }>;
}

interface FinetuneCapableModel {
  finetune(finetuningOptions?: FinetuningOptions): Promise<FinetuneHandle>;
}

function isFinetuneCapableModel(model: unknown): model is FinetuneCapableModel {
  if (!model || typeof model !== "object") {
    return false;
  }

  const candidate = model as { finetune?: unknown };
  return typeof candidate.finetune === "function";
}

export async function finetune(params: FinetuneParams) {
  const { modelId, finetuningOptions } = finetuneParamsSchema.parse(params);
  const model = getModel(modelId);

  if (!isFinetuneCapableModel(model)) {
    throw new CompletionFailedError(
      `Model "${modelId}" does not support finetuning`,
    );
  }

  const modelConfig = getModelConfig(modelId) as { flash_attn?: string };
  if (modelConfig.flash_attn !== "off") {
    throw new CompletionFailedError(
      `Model "${modelId}" is not loaded in finetune mode. Reload it with loadModel({ ..., mode: "finetune" }) before calling finetune().`,
    );
  }

  try {
    const handle = await model.finetune(finetuningOptions);

    if (!handle || typeof handle.await !== "function") {
      throw new CompletionFailedError("Finetune handle was not returned");
    }

    const result = await handle.await();
    const parsedStatus = finetuneStatusSchema.safeParse(result.status);

    if (!parsedStatus.success) {
      throw new CompletionFailedError(
        `Invalid finetune status: ${String(result.status)}`,
      );
    }

    return parsedStatus.data;
  } catch (error) {
    if (error instanceof CompletionFailedError) {
      throw error;
    }

    throw new CompletionFailedError(
      error instanceof Error ? error.message : "Unknown finetuning error",
      error,
    );
  }
}
