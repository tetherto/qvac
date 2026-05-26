import type {
  VideoStreamRequest,
  VideoStreamResponse,
} from "@/schemas/sdcpp-config";
import { dispatchPluginStream } from "@/server/rpc/handlers/plugin-dispatch";

export async function* handleVideoStream(
  request: VideoStreamRequest,
): AsyncGenerator<VideoStreamResponse> {
  yield* dispatchPluginStream<VideoStreamRequest, VideoStreamResponse>(
    request.modelId,
    "videoStream",
    request,
  );
}
