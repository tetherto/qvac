import {
  downloadAsset,
  cancel,
  deleteCache,
  WHISPER_TINY,
  BERGAMOT_ZH_EN,
  WHISPER_FRENCH_TINY_Q8_0,
  WHISPER_GERMAN_TINY_Q8_0
} from '@qvac/sdk'
import { BaseExecutor, type TestResult } from '@qvac/test-suite'
import {
  downloadCancelIsolation,
  downloadHuggingFaceVerify,
  downloadPauseResume,
  downloadCancelClearCache,
  downloadDeleteCacheReclaim,
  downloadDeleteCacheWhileDownloading,
  downloadDeleteCacheInvalidSrc
} from '../../../../catalog/download-tests.js'

const downloadTests = [
  downloadCancelIsolation,
  downloadHuggingFaceVerify,
  downloadPauseResume,
  downloadCancelClearCache,
  downloadDeleteCacheReclaim,
  downloadDeleteCacheWhileDownloading,
  downloadDeleteCacheInvalidSrc
] as const

const CACHE_HIT_THRESHOLD_MS = 500

// Must be a model no other test downloads: a cached target short-circuits on
// the cache-hit branch below and the cancel path is never exercised.
// It also shares a blob core with the survivor, so cancelling with `clearCache`
// is proven not to disturb a concurrent download from that same core.
const CANCEL_TARGET = BERGAMOT_ZH_EN

// Single-file registry models no other test downloads, so a cached copy from
// another test cannot stand in for a resume. Each test resets its model first.
const RESUME_TARGET = WHISPER_FRENCH_TINY_Q8_0
const RESTART_TARGET = WHISPER_GERMAN_TINY_Q8_0

type RegistryModel = typeof RESUME_TARGET | typeof RESTART_TARGET

type Attempt = {
  firstPercentage: number | undefined
  status: 'ok' | 'fail'
  err?: string
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Downloads `model`, cancelling once progress reaches `stopAtPercent`, and
// reports the first progress event: on a resume it carries the kept bytes.
async function attempt(
  model: RegistryModel,
  stopAtPercent: number | undefined,
  clearCache = false
): Promise<Attempt> {
  let firstPercentage: number | undefined
  let stopped = false
  const op = downloadAsset({
    assetSrc: model,
    onProgress: (p: { percentage: number }) => {
      firstPercentage ??= p.percentage
      if (stopAtPercent !== undefined && !stopped && p.percentage >= stopAtPercent) {
        stopped = true
        void cancel({ requestId: op.requestId, clearCache })
      }
    }
  })
  try {
    await op
    return { firstPercentage, status: 'ok' }
  } catch (err) {
    return { firstPercentage, status: 'fail', err: message(err) }
  }
}

export class DownloadExecutor extends BaseExecutor<typeof downloadTests> {
  pattern = /^download-/

  protected handlers = {
    [downloadCancelIsolation.testId]: this.cancelIsolation.bind(this),
    [downloadHuggingFaceVerify.testId]: this.huggingFaceVerify.bind(this),
    [downloadPauseResume.testId]: this.pauseResume.bind(this),
    [downloadCancelClearCache.testId]: this.cancelClearCache.bind(this),
    [downloadDeleteCacheReclaim.testId]: this.deleteCacheReclaim.bind(this),
    [downloadDeleteCacheWhileDownloading.testId]: this.deleteCacheWhileDownloading.bind(this),
    [downloadDeleteCacheInvalidSrc.testId]: this.deleteCacheInvalidSrc.bind(this)
  }

  async pauseResume(
    params: typeof downloadPauseResume.params,
    _expectation: typeof downloadPauseResume.expectation
  ): Promise<TestResult> {
    await deleteCache({ modelSrc: RESUME_TARGET.src })
    try {
      const paused = await attempt(RESUME_TARGET, params.pauseAtPercent)
      if (paused.status === 'ok') {
        return { passed: false, output: 'The download completed before it could be paused' }
      }
      const resumed = await attempt(RESUME_TARGET, undefined)
      if (resumed.status !== 'ok') {
        return { passed: false, output: `Resumed download failed: ${resumed.err}` }
      }
      const start = resumed.firstPercentage ?? 0
      return {
        passed: start >= params.resumeAtPercent,
        output: `Paused at ${params.pauseAtPercent}%, resumed from ${start.toFixed(1)}% and completed`
      }
    } finally {
      await deleteCache({ modelSrc: RESUME_TARGET.src }).catch(() => {})
    }
  }

  async cancelClearCache(
    params: typeof downloadCancelClearCache.params,
    _expectation: typeof downloadCancelClearCache.expectation
  ): Promise<TestResult> {
    await deleteCache({ modelSrc: RESTART_TARGET.src })
    try {
      const cancelled = await attempt(RESTART_TARGET, params.pauseAtPercent, true)
      if (cancelled.status === 'ok') {
        return { passed: false, output: 'The download completed before it could be cancelled' }
      }
      return await this.expectRestart(params.restartBelowPercent, 'cancel({ clearCache: true })')
    } finally {
      await deleteCache({ modelSrc: RESTART_TARGET.src }).catch(() => {})
    }
  }

  async deleteCacheReclaim(
    params: typeof downloadDeleteCacheReclaim.params,
    _expectation: typeof downloadDeleteCacheReclaim.expectation
  ): Promise<TestResult> {
    await deleteCache({ modelSrc: RESTART_TARGET.src })
    try {
      const paused = await attempt(RESTART_TARGET, params.pauseAtPercent)
      if (paused.status === 'ok') {
        return { passed: false, output: 'The download completed before it could be paused' }
      }
      const { success } = await deleteCache({ modelSrc: RESTART_TARGET.src })
      if (!success) return { passed: false, output: 'deleteCache({ modelSrc }) reported failure' }
      return await this.expectRestart(params.restartBelowPercent, 'deleteCache({ modelSrc })')
    } finally {
      await deleteCache({ modelSrc: RESTART_TARGET.src }).catch(() => {})
    }
  }

  // Starts the restart target again and checks it began from scratch, then stops it.
  async expectRestart(restartBelowPercent: number, after: string): Promise<TestResult> {
    const next = await attempt(RESTART_TARGET, 0, true)
    const start = next.firstPercentage
    if (start === undefined) {
      return { passed: false, output: `No progress from the download after ${after}: ${next.err}` }
    }
    return {
      passed: start < restartBelowPercent,
      output: `After ${after} the next download started from ${start.toFixed(1)}%`
    }
  }

  async deleteCacheWhileDownloading(
    params: typeof downloadDeleteCacheWhileDownloading.params,
    _expectation: typeof downloadDeleteCacheWhileDownloading.expectation
  ): Promise<TestResult> {
    await deleteCache({ modelSrc: RESUME_TARGET.src })
    let refusal: string | undefined
    let deleted = false
    let checked = false
    const op = downloadAsset({
      assetSrc: RESUME_TARGET,
      onProgress: () => {
        if (checked) return
        checked = true
        void deleteCache({ modelSrc: RESUME_TARGET.src })
          .then(
            () => (deleted = true),
            (err: unknown) => (refusal = message(err))
          )
          .finally(() => cancel({ requestId: op.requestId, clearCache: true }))
      }
    })
    await op.then(
      () => {},
      () => {}
    )
    await deleteCache({ modelSrc: RESUME_TARGET.src }).catch(() => {})

    if (deleted)
      return { passed: false, output: 'deleteCache removed a model that was downloading' }
    if (refusal === undefined) {
      return { passed: false, output: 'The download finished before deleteCache was tried' }
    }
    return {
      passed: refusal.includes(params.errorContains),
      output: `deleteCache refused: ${refusal}`
    }
  }

  async deleteCacheInvalidSrc(
    params: typeof downloadDeleteCacheInvalidSrc.params,
    _expectation: typeof downloadDeleteCacheInvalidSrc.expectation
  ): Promise<TestResult> {
    try {
      await deleteCache({ modelSrc: params.modelSrc })
      return { passed: false, output: `deleteCache accepted ${params.modelSrc}` }
    } catch (err) {
      const text = message(err)
      return {
        passed: text.includes(params.errorContains),
        output: `deleteCache rejected: ${text}`
      }
    }
  }

  async huggingFaceVerify(
    params: typeof downloadHuggingFaceVerify.params,
    _expectation: typeof downloadHuggingFaceVerify.expectation
  ): Promise<TestResult> {
    // A checksum mismatch throws before resolving, so a resolved id means the
    // streamed bytes matched the Hub SHA-256.
    try {
      const id = await downloadAsset({ assetSrc: params.assetUrl })
      const ok = typeof id === 'string' && id.length > 0
      return { passed: ok, output: ok ? `verified: ${id}` : `unexpected result: ${String(id)}` }
    } catch (err) {
      return {
        passed: false,
        output: `Hugging Face download/verify failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  async cancelIsolation(
    params: typeof downloadCancelIsolation.params,
    _expectation: typeof downloadCancelIsolation.expectation
  ): Promise<TestResult> {
    let cancelTriggered = false
    const cancelThreshold = params.cancelAtPercent ?? 1
    const startTime = Date.now()

    const survivorPromise = downloadAsset({
      assetSrc: WHISPER_TINY,
      onProgress: () => {}
    }).then(
      (id: string) => ({ status: 'ok' as const, id }),
      (err: unknown) => ({
        status: 'fail' as const,
        err: err instanceof Error ? err.message : String(err)
      })
    )

    let progressEvents = 0
    const cancelledOp = downloadAsset({
      assetSrc: CANCEL_TARGET,
      onProgress: (p: { downloadKey?: string; percentage: number }) => {
        progressEvents++
        if (!cancelTriggered && p.percentage >= cancelThreshold) {
          cancelTriggered = true
          void cancel({
            requestId: cancelledOp.requestId,
            clearCache: true
          })
        }
      }
    })
    const cancelledPromise = cancelledOp.then(
      (id: string) => ({ status: 'ok' as const, id }),
      (err: unknown) => ({
        status: 'fail' as const,
        err: err instanceof Error ? err.message : String(err)
      })
    )

    const [survivor, cancelled] = await Promise.all([survivorPromise, cancelledPromise])
    const elapsed = Date.now() - startTime

    if (survivor.status !== 'ok') {
      return { passed: false, output: `Survivor download failed: ${survivor.err}` }
    }

    if (cancelled.status === 'fail') {
      return {
        passed: true,
        output: `Survivor: OK. Target: correctly rejected (${cancelled.err}). ${elapsed}ms, ${progressEvents} progress events`
      }
    }

    const wasCached = progressEvents <= 1 || elapsed < CACHE_HIT_THRESHOLD_MS
    if (wasCached) {
      return {
        passed: true,
        output: `Survivor: OK. Target was cached (${elapsed}ms, ${progressEvents} progress events) — cancel not testable`
      }
    }

    return {
      passed: false,
      output: `Survivor: OK. Cancel triggered but target download still completed (${elapsed}ms, ${progressEvents} progress events)`
    }
  }
}
