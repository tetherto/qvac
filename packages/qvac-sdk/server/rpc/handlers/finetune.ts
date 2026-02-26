import type { FinetuneRequest, FinetuneResponse } from "@/schemas";
import { dispatchPluginReply } from "@/server/rpc/handlers/plugin-dispatch";

export async function handleFinetune(
  request: FinetuneRequest,
): Promise<FinetuneResponse> {
  return dispatchPluginReply<FinetuneRequest, FinetuneResponse>(
    request.modelId,
    "finetune",
    request,
  );
}
