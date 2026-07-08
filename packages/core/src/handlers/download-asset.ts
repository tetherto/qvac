import type { DownloadAssetRequest, DownloadAssetResponse, ModelProgressUpdate } from '../schemas'
import { PROFILING_KEY, OPERATION_EVENT_KEY, type OperationEvent } from '../schemas'
import { resolveModelPath, resolveModelPathWithStats } from './load-model/resolve'
import {
  buildDownloadProfilingFields,
  type DownloadStats,
  type DownloadHooks
} from './load-model/types'
import { nowMs, generateProfileId } from '../profiling/clock'
import { getEngineLogger } from '../logging'
import { getRequestRegistry, withRequestContext } from '../runtime'
import { generateRandomRequestId } from '../runtime/request-id'
import { InferenceCancelledError } from '../errors'

const logger = getEngineLogger()

export async function handleDownloadAsset(
  request: DownloadAssetRequest,
  progressCallback?: (update: ModelProgressUpdate) => void
): Promise<DownloadAssetResponse> {
  const { assetSrc, seed } = request

  const profilingMeta = (request as Record<string, unknown>)[PROFILING_KEY] as
    { enabled?: boolean; id?: string } | undefined
  const profilingEnabled = profilingMeta?.enabled !== false && !!profilingMeta

  const requestId = request.requestId ?? generateRandomRequestId()
  // `downloadAsset` is artifact-shaped, not model-shaped — there is no
  // `modelId` to register on the registry entry. Cancel by `requestId`
  // is the primary path; `cancel({ modelId })` is intentionally a
  // non-match for this kind.
  await using ctx = await getRequestRegistry().begin({
    requestId,
    kind: 'downloadAsset'
  })
  const log = withRequestContext(getEngineLogger(), ctx)
  log.debug(`downloadAsset start assetSrc=${assetSrc}`)

  const hooks: DownloadHooks = {
    requestBinding: {
      signal: ctx.signal,
      scope: ctx.scope,
      requestId
    }
  }

  try {
    const totalDownloadStart = profilingEnabled ? nowMs() : 0

    let sourceType: string | undefined
    let downloadStats: DownloadStats | undefined

    if (profilingEnabled) {
      const result = await resolveModelPathWithStats(
        assetSrc,
        progressCallback,
        seed,
        ctx.signal,
        hooks
      )
      sourceType = result.sourceType
      downloadStats = result.downloadStats
    } else {
      await resolveModelPath(assetSrc, progressCallback, seed, ctx.signal, hooks)
    }

    const response: DownloadAssetResponse = {
      type: 'downloadAsset',
      success: true,
      assetId: assetSrc
    }

    if (profilingEnabled) {
      const totalDownloadTimeMs = nowMs() - totalDownloadStart
      const profileId = profilingMeta?.id ?? generateProfileId()

      const { gauges, tags } = buildDownloadProfilingFields(downloadStats, sourceType)
      gauges['totalDownloadTime'] = totalDownloadTimeMs

      const operationEvent: OperationEvent = {
        op: 'downloadAsset',
        kind: 'handler',
        ms: totalDownloadTimeMs,
        profileId,
        gauges: Object.keys(gauges).length > 0 ? gauges : undefined,
        tags: Object.keys(tags).length > 0 ? tags : undefined
      }

      ;(response as DownloadAssetResponse & { [OPERATION_EVENT_KEY]?: OperationEvent })[
        OPERATION_EVENT_KEY
      ] = operationEvent
    }

    return response
  } catch (error: unknown) {
    // Mirror the load-model handler's cancel contract: a typed cancel
    // bubbles up as the rejection so client-side callers can branch on
    // `instanceof InferenceCancelledError`. Every other error keeps
    // the legacy `success: false` envelope.
    if (error instanceof InferenceCancelledError) {
      log.info(`downloadAsset cancelled requestId=${requestId}`)
      throw error
    }
    logger.error('Error downloading asset:', error)
    return {
      type: 'downloadAsset',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
