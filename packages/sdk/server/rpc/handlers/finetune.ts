import type { FinetuneRequest, FinetuneResponse, FinetuneProgress } from "@/schemas";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";
import {
  finetunePause,
  finetuneCancel,
} from "@/server/bare/plugins/llamacpp-completion/ops/finetune";

export async function* handleFinetune(
  request: FinetuneRequest,
): AsyncGenerator<FinetuneProgress | FinetuneResponse> {
  switch (request.op) {
    case "start":
      yield* dispatchPluginStream<
        FinetuneRequest,
        FinetuneProgress | FinetuneResponse
      >(request.modelId, "finetune", request);
      break;
    case "pause":
      yield await finetunePause(request);
      break;
    case "cancel":
      yield await finetuneCancel(request);
      break;
  }
}
