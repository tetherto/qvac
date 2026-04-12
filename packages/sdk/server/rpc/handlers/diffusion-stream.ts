import type {
  DiffusionStreamRequest,
  DiffusionStreamResponse,
} from "@/schemas/sdcpp-config";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleDiffusionStream(
  request: DiffusionStreamRequest,
): AsyncGenerator<DiffusionStreamResponse> {
  yield* dispatchPluginStream<DiffusionStreamRequest, DiffusionStreamResponse>(
    request.modelId,
    "diffusionStream",
    request,
  );
}
