import type {
  UpscaleStreamRequest,
  UpscaleStreamResponse,
} from "@/schemas/sdcpp-config";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleUpscaleStream(
  request: UpscaleStreamRequest,
): AsyncGenerator<UpscaleStreamResponse> {
  yield* dispatchPluginStream<UpscaleStreamRequest, UpscaleStreamResponse>(
    request.modelId,
    "upscaleStream",
    request,
  );
}
