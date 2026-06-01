import type {
  ClassifyRequest,
  ClassifyResponse,
} from "@/schemas/classification";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleClassify(
  request: ClassifyRequest,
): AsyncGenerator<ClassifyResponse> {
  yield* dispatchPluginStream<ClassifyRequest, ClassifyResponse>(
    request.modelId,
    "classify",
    request,
  );
}
