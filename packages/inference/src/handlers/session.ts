import type {
  OpenSessionRequest,
  OpenSessionResponse,
  CloseSessionRequest,
  CloseSessionResponse
} from '@/schemas/session'
import { openSession, closeSession, finishSessionClose } from '@/runtime/session-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { getModelIdsLeasedBy } from '@/runtime/model-registry'
import { disposeSessionVectorIndexes } from '@/runtime/vector-index-registry'
import { unloadModel } from '@/plugins/ops/unload-model'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

export function handleOpenSession(request: OpenSessionRequest): OpenSessionResponse {
  const entry = openSession(request.sessionId, request.name)
  return { type: 'openSession', success: true, sessionId: entry.id }
}

/**
 * Closing a session cancels its requests, waits for them to leave the
 * registry, then disposes the vector indexes it opened and releases every
 * model lease it holds. A model whose last lease was released is unloaded.
 * The session record is removed first so a
 * call racing the close is refused at dispatch instead of starting work on a
 * session that is going away. Its id is not reusable until the close returns.
 */
export async function handleCloseSession(
  request: CloseSessionRequest
): Promise<CloseSessionResponse> {
  const { sessionId } = request
  closeSession(sessionId)
  try {
    const cancelled = await getRequestRegistry().drainSession(sessionId, 'sessionClosed')
    disposeSessionVectorIndexes(sessionId)

    const releasedModels = getModelIdsLeasedBy(sessionId)
    for (const modelId of releasedModels) {
      try {
        await unloadModel({ modelId, sessionId })
      } catch (error) {
        logger.error(`Error releasing model ${modelId} for session ${sessionId}:`, error)
      }
    }

    return { type: 'closeSession', success: true, sessionId, cancelled, releasedModels }
  } finally {
    finishSessionClose(sessionId)
  }
}
