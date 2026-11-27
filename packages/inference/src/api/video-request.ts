import type { VideoClientParams, VideoStreamRequest } from '@/schemas/sdcpp-config'
import { encodeBase64 } from '@/utils/encoding'

export function createVideoStreamRequest(params: VideoClientParams, requestId: string) {
  const { controlFrames, initImage, referenceImages, ...rest } = params
  return {
    ...rest,
    ...(controlFrames !== undefined && {
      controlFrames: controlFrames.map(encodeBase64)
    }),
    ...(initImage !== undefined && {
      initImage: encodeBase64(initImage)
    }),
    ...(referenceImages !== undefined && {
      referenceImages: referenceImages.map(encodeBase64)
    }),
    type: 'videoStream' as const,
    requestId
  } satisfies VideoStreamRequest
}
