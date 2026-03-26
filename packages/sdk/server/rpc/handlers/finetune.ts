import type { FinetuneRequest, FinetuneResponse, FinetuneProgress } from "@/schemas";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleFinetune(
  request: FinetuneRequest,
): AsyncGenerator<FinetuneProgress | FinetuneResponse> {
  yield* dispatchPluginStream<
    FinetuneRequest,
    FinetuneProgress | FinetuneResponse
  >(request.modelId, "finetune", request);
}
