import type { AudioUnderstandClientParams, AudioUnderstandResult } from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { createAudioUnderstandResult } from '@/client/api/audio-gen-result'

/**
 * Describes a recording with a loaded ACE-Step AudioGen model, running the
 * engine's reverse pipeline: the PCM is encoded, its FSQ semantic codes are
 * recovered, and the LM reports a caption and the clip's metadata.
 */
export function audioUnderstand(params: AudioUnderstandClientParams): AudioUnderstandResult {
  return createAudioUnderstandResult(params, streamRpc)
}
