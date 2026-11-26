import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SDK_LOG_ID } from '@qvac/sdk'
import type { Logger } from '@/logger'
import { createSdkWarnings } from '@/serve/core/sdk-warnings'

type LogLine = { level: 'error' | 'warn' | 'info' | 'debug'; message: string }
type SdkLogSource = NonNullable<Parameters<typeof createSdkWarnings>[1]>

function makeLogger() {
  const lines: string[] = []
  const logger: Logger = {
    error: (m) => lines.push(`error ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    info: (m) => lines.push(`info ${m}`),
    debug: (m) => lines.push(`debug ${m}`)
  }
  return { logger, lines }
}

/** Each subscription yields `logs`, then stays open until aborted unless
 * `endAfterLogs` is set, which ends it like a worker that exited. */
function makeSource(logs: LogLine[], endAfterLogs = false) {
  const subscriptions: { id: string; signal: AbortSignal | undefined }[] = []
  let ended!: () => void
  const endedOnce = new Promise<void>((resolve) => {
    ended = resolve
  })
  const source = async function* (params: { id: string }, options?: { signal?: AbortSignal }) {
    const signal = options?.signal
    subscriptions.push({ id: params.id, signal })
    for (const log of logs) {
      yield {
        type: 'loggingStream' as const,
        id: params.id,
        namespace: 'engine',
        timestamp: 0,
        ...log
      }
    }
    if (!endAfterLogs) {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
    }
    ended()
  } as unknown as SdkLogSource
  return { source, subscriptions, endedOnce }
}

describe('createSdkWarnings', () => {
  it('prints SDK warnings and errors and leaves lower levels out', async () => {
    const { logger, lines } = makeLogger()
    const { source, subscriptions, endedOnce } = makeSource(
      [
        { level: 'info', message: 'Model already cached and validated' },
        { level: 'warn', message: 'Ignoring cached model.gguf: checksum a, expected b' },
        { level: 'debug', message: 'detail' },
        { level: 'error', message: 'load failed' }
      ],
      true
    )

    createSdkWarnings(logger, source).ensure()
    await endedOnce

    assert.equal(subscriptions[0]?.id, SDK_LOG_ID)
    assert.deepEqual(lines, [
      'warn Ignoring cached model.gguf: checksum a, expected b',
      'error load failed'
    ])
  })

  it('keeps one stream while it is open', () => {
    const { logger } = makeLogger()
    const { source, subscriptions } = makeSource([])
    const warnings = createSdkWarnings(logger, source)

    warnings.ensure()
    warnings.ensure()

    assert.equal(subscriptions.length, 1)
    warnings.stop()
  })

  it('opens a new stream after the previous one ended', async () => {
    const { logger } = makeLogger()
    const { source, subscriptions, endedOnce } = makeSource([], true)
    const warnings = createSdkWarnings(logger, source)

    warnings.ensure()
    await endedOnce
    await new Promise((resolve) => setImmediate(resolve))
    warnings.ensure()

    assert.equal(subscriptions.length, 2)
  })

  it('aborts the stream when stopped', () => {
    const { logger } = makeLogger()
    const { source, subscriptions } = makeSource([])
    const warnings = createSdkWarnings(logger, source)

    warnings.ensure()
    assert.equal(subscriptions[0]?.signal?.aborted, false)
    warnings.stop()
    assert.equal(subscriptions[0]?.signal?.aborted, true)
  })
})
