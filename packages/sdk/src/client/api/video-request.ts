import type { VideoClientParams, VideoStreamRequest } from '@qvac/inference/surface'
import { encodeBase64 } from '@/utils/encoding'

export function createVideoStreamRequest(params: VideoClientParams, requestId: string) {
  const { control_frames, init_image, reference_images, ...rest } = params
  return {
    ...rest,
    ...(control_frames !== undefined && {
      control_frames: control_frames.map(encodeBase64)
    }),
    ...(init_image !== undefined && {
      init_image: encodeBase64(init_image)
    }),
    ...(reference_images !== undefined && {
      reference_images: reference_images.map(encodeBase64)
    }),
    type: 'videoStream' as const,
    requestId
  } satisfies VideoStreamRequest
}
