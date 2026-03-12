import type {
  GenerationStreamRequest,
  GenerationStreamResponse,
} from "@/schemas/sdcpp-config";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleGenerationStream(
  request: GenerationStreamRequest,
): AsyncGenerator<GenerationStreamResponse> {
  yield* dispatchPluginStream<GenerationStreamRequest, GenerationStreamResponse>(
    request.modelId,
    "generationStream",
    request,
  );
}
