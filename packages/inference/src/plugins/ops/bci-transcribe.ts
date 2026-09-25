import { getModel } from '@/runtime/model-registry'
import {
  type BciStreamOpts,
  type BciTranscribeParams,
  type NeuralInput,
  type TranscribeSegment,
  type TranscribeStats
} from '@/schemas/index'
import Buffer from 'bare-buffer'
import { getEngineLogger } from '@/logging/index'
import { TranscriptionFailedError } from '@/errors/index'
import { nowMs } from '@/profiling/index'
import { buildStreamResult, type StreamResult } from '@/profiling/model-execution'
import { buildAsrBackendDiagnostics } from '@/utils/asr-diagnostics'
import type { InferenceBackendDiagnostics } from '@/schemas/index'
import { toTranscribeSegment, type AsrAddonSegment } from '@/utils/transcribe-metadata'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'

interface BciAddonResponse {
  iterate(): AsyncIterable<AsrAddonSegment[] | AsrAddonSegment>
  /**
   * The stats `BCIModel.cpp` emits. Its `totalTime` is left out: the addon
   * reports it in seconds, while the shared schema field is milliseconds, and
   * `totalWallMs` already carries the same measurement in ms.
   */
  stats?: {
    tokensPerSecond?: number
    totalTokens?: number
    totalSegments?: number
    totalWallMs?: number
    processCalls?: number
    whisperEncodeMs?: number
    whisperDecodeMs?: number
    whisperSampleMs?: number
    whisperBatchdMs?: number
    whisperPromptMs?: number
    backendDevice?: number
    backendId?: number
    gpuMemTotalMb?: number
    gpuMemFreeMb?: number
  }
}

// The BCI addon (`@qvac/bci-whispercpp`) exposes a batch transcription
// surface keyed on a neural-signal buffer rather than the audio-stream
// `run()` contract shared by whisper / parakeet. These methods are not
// on `BaseInference`, so `getModel(...)` is narrowed to this shape.
interface BciTranscribableModel {
  transcribe(neuralData: Uint8Array): Promise<BciAddonResponse>
  transcribeFile(filePath: string): Promise<BciAddonResponse>
  cancel(): Promise<void>
}

// Sliding-window streaming surface. `transcribeStream` drives the same
// batch `runJob` pipeline window-by-window over an async iterable of
// neural-signal chunks, emitting per-window updates through the
// returned `QvacResponse`.
interface BciStreamableModel {
  transcribeStream(
    neuralStream: AsyncIterable<Uint8Array>,
    streamOpts?: {
      windowTimesteps?: number
      hopTimesteps?: number
      emit?: 'delta' | 'full'
    }
  ): Promise<BciAddonResponse>
  cancel(): Promise<void>
}

async function runBci(model: BciTranscribableModel, input: NeuralInput): Promise<BciAddonResponse> {
  switch (input.type) {
    case 'base64':
      return model.transcribe(Buffer.from(input.value, 'base64'))
    case 'filePath':
      return model.transcribeFile(input.value)
    default:
      throw new TranscriptionFailedError('Invalid neural input')
  }
}

type BciTranscribeReturn = {
  modelExecutionMs: number
  stats?: TranscribeStats
  diagnostics?: InferenceBackendDiagnostics
}

export function bciTranscribe(
  params: BciTranscribeParams & { metadata: true },
  requestId?: string
): AsyncGenerator<TranscribeSegment, BciTranscribeReturn, void>
export function bciTranscribe(
  params: BciTranscribeParams,
  requestId?: string
): AsyncGenerator<string, BciTranscribeReturn, void>
export async function* bciTranscribe(
  params: BciTranscribeParams,
  requestId?: string
): AsyncGenerator<string | TranscribeSegment, BciTranscribeReturn, void> {
  const { modelId, metadata } = params

  // Open a request-scoped lifecycle. The registry routes
  // `cancel({ requestId })` and `cancel({ modelId, kind: "transcribe" })`
  // through this context. Falls back to a generated id if the
  // caller didn't send one.
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'transcribe',
    modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)

  const model = getModel(modelId) as unknown as BciTranscribableModel

  // Hard-cancel wiring: the BCI addon exposes a model-wide `cancel()`
  // that interrupts the currently-running job. The per-iteration
  // `if (ctx.signal.aborted) break` below is the soft-cancel safety net
  // for the gap between the abort firing and the iterator's next pull.
  const onAbort = () => {
    if (typeof model.cancel === 'function') {
      model.cancel().catch((err: unknown) => {
        requestLogger.warn(
          `[cancel] model.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener('abort', onAbort)
  })

  const modelStart = nowMs()
  const response = await runBci(model, params.neuralData)

  for await (const output of response.iterate()) {
    if (ctx.signal.aborted) break
    requestLogger.debug('BCI Transcription Update:', output)

    const chunks = Array.isArray(output) ? output : [output]

    if (metadata) {
      for (const chunk of chunks) {
        if (!chunk.text) continue
        yield toTranscribeSegment(chunk)
      }
      continue
    }

    const text = chunks.map((chunk) => chunk.text).join('')
    if (text.trim()) {
      yield text
    }
  }
  const modelExecutionMs = nowMs() - modelStart

  const stats: TranscribeStats = {
    ...(response.stats?.tokensPerSecond !== undefined && {
      tokensPerSecond: response.stats.tokensPerSecond
    }),
    ...(response.stats?.totalTokens !== undefined && {
      totalTokens: response.stats.totalTokens
    }),
    ...(response.stats?.totalSegments !== undefined && {
      totalSegments: response.stats.totalSegments
    }),
    ...(response.stats?.whisperEncodeMs !== undefined && {
      whisperEncodeTime: response.stats.whisperEncodeMs
    }),
    ...(response.stats?.whisperDecodeMs !== undefined && {
      whisperDecodeTime: response.stats.whisperDecodeMs
    }),
    ...(response.stats?.whisperSampleMs !== undefined && {
      whisperSampleMs: response.stats.whisperSampleMs
    }),
    ...(response.stats?.whisperBatchdMs !== undefined && {
      whisperBatchdMs: response.stats.whisperBatchdMs
    }),
    ...(response.stats?.whisperPromptMs !== undefined && {
      whisperPromptMs: response.stats.whisperPromptMs
    }),
    ...(response.stats?.totalWallMs !== undefined && { totalWallMs: response.stats.totalWallMs }),
    ...(response.stats?.processCalls !== undefined && {
      processCalls: response.stats.processCalls
    }),
    ...(response.stats?.backendDevice !== undefined && {
      backendDevice: response.stats.backendDevice
    }),
    ...(response.stats?.backendId !== undefined && {
      backendId: response.stats.backendId
    }),
    ...(response.stats?.gpuMemTotalMb !== undefined && {
      gpuMemTotalMb: response.stats.gpuMemTotalMb
    }),
    ...(response.stats?.gpuMemFreeMb !== undefined && {
      gpuMemFreeMb: response.stats.gpuMemFreeMb
    })
  }

  const diagnostics = buildAsrBackendDiagnostics(stats)
  return {
    ...buildStreamResult(modelExecutionMs, stats),
    ...(diagnostics && { diagnostics })
  }
}

// The addon reports no `stats` for a stream, so the return carries only the
// locally measured execution time — which the profiling layer needs either way.
type BciStreamReturn = StreamResult

export function bciTranscribeStream(
  modelId: string,
  neuralStream: AsyncIterable<Buffer>,
  metadata: true,
  opts?: BciStreamOpts,
  requestId?: string
): AsyncGenerator<TranscribeSegment, BciStreamReturn, void>
export function bciTranscribeStream(
  modelId: string,
  neuralStream: AsyncIterable<Buffer>,
  metadata?: boolean,
  opts?: BciStreamOpts,
  requestId?: string
): AsyncGenerator<string, BciStreamReturn, void>
export async function* bciTranscribeStream(
  modelId: string,
  neuralStream: AsyncIterable<Buffer>,
  metadata?: boolean,
  opts?: BciStreamOpts,
  requestId?: string
): AsyncGenerator<string | TranscribeSegment, BciStreamReturn, void> {
  // Same `kind: "transcribe"` as the unary BCI variant — the registry
  // doesn't distinguish streaming vs non-streaming variants of the same
  // operation, so `cancel({ modelId, kind: "transcribe" })` cancels
  // either shape.
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'transcribe',
    modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)

  const model = getModel(modelId) as unknown as BciStreamableModel

  // Hard-cancel wiring: `cancel()` tears down the active stream driver
  // and interrupts the running window job. The per-iteration abort guard
  // below is the soft-cancel safety net between the abort firing and the
  // iterator's next pull.
  const onAbort = () => {
    if (typeof model.cancel === 'function') {
      model.cancel().catch((err: unknown) => {
        requestLogger.warn(
          `[cancel] model.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener('abort', onAbort)
  })

  const streamOpts = {
    ...(opts?.windowTimesteps !== undefined && {
      windowTimesteps: opts.windowTimesteps
    }),
    ...(opts?.hopTimesteps !== undefined && { hopTimesteps: opts.hopTimesteps }),
    ...(opts?.emit !== undefined && { emit: opts.emit })
  }

  const modelStart = nowMs()
  const response = await model.transcribeStream(neuralStream, streamOpts)

  for await (const output of response.iterate()) {
    if (ctx.signal.aborted) break
    requestLogger.debug('BCI Stream Transcription Update:', output)

    const chunks = Array.isArray(output) ? output : [output]

    if (metadata) {
      for (const chunk of chunks) {
        if (!chunk.text) continue
        yield toTranscribeSegment(chunk)
      }
      continue
    }

    const text = chunks.map((chunk) => chunk.text).join('')
    if (text.trim()) {
      yield text
    }
  }

  return buildStreamResult(nowMs() - modelStart)
}
