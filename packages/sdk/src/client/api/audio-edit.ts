import type { AudioEditClientParams, AudioGenResult } from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { createAudioEditResult } from '@/client/api/audio-gen-result'

/**
 * Edits a source recording with a loaded ACE-Step AudioGen model: an ordered
 * pipeline of `flow-edit` and `repaint` operations, executed in array order.
 */
export function audioEdit(params: AudioEditClientParams): AudioGenResult {
  return createAudioEditResult(params, streamRpc)
}
