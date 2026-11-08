import type { AudioGenClientParams, AudioGenResult } from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { createAudioGenResult } from '@/client/api/audio-gen-result'

/**
 * Generates PCM audio using a loaded AudioGen model.
 */
export function audioGen(params: AudioGenClientParams): AudioGenResult {
  return createAudioGenResult(params, streamRpc)
}
