import { send, stream as streamRpc } from '@/client/rpc/rpc-client'
import {
  finetuneRunParamsSchema,
  finetuneRunRequestSchema,
  finetuneStopRequestSchema,
  finetuneGetStateParamsSchema,
  finetuneGetStateRequestSchema,
  finetuneProgressResponseSchema,
  finetuneResponseSchema,
  type FinetuneGetStateParams,
  type FinetuneParams,
  type FinetuneProgress,
  type FinetuneResult,
  type FinetuneRunParams,
  type FinetuneStopParams,
  type RPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError, StreamEndedError } from '@/utils/errors-client'
import { parseClientInput } from '@/client/parse-input'
import { generateClientRequestId } from '@/client/api/client-request-id'

export interface FinetuneHandle {
  progressStream: AsyncGenerator<FinetuneProgress>
  result: Promise<FinetuneResult>
  /** Stable id for this run; pass to `cancel({ requestId })` to stop it. */
  requestId: string
}

type FinetuneReplyParams = FinetuneStopParams | FinetuneGetStateParams

function isFinetuneReplyParams(params: FinetuneParams): params is FinetuneReplyParams {
  return (
    params.operation === 'pause' || params.operation === 'cancel' || params.operation === 'getState'
  )
}

function createFinetuneReplyRequest(params: FinetuneReplyParams) {
  if (params.operation === 'getState') {
    const getStateParams = parseClientInput(finetuneGetStateParamsSchema, params)
    return parseClientInput(finetuneGetStateRequestSchema, {
      type: 'finetune',
      ...getStateParams
    })
  }

  return parseClientInput(finetuneStopRequestSchema, {
    type: 'finetune',
    modelId: params.modelId,
    operation: params.operation
  })
}

/**
 * Starts, resumes, inspects, pauses, or cancels a finetuning job for a loaded model.
 */
/**
 * Run / start / resume a finetune job. Returns a handle with a streaming
 * `progressStream` and a terminal `result` promise.
 *
 * @overloadLabel "Run / start / resume"
 */
export function finetune(params: FinetuneRunParams, rpcOptions?: RPCOptions): FinetuneHandle

/**
 * Stop / pause / cancel an in-flight finetune, or query its current state.
 *
 * @overloadLabel "Stop / getState / pause / cancel"
 */
export function finetune(
  params: FinetuneReplyParams,
  rpcOptions?: RPCOptions
): Promise<FinetuneResult>

export function finetune(
  params: FinetuneParams,
  rpcOptions?: RPCOptions
): FinetuneHandle | Promise<FinetuneResult> {
  if (isFinetuneReplyParams(params)) {
    const request = createFinetuneReplyRequest(params)

    const resultPromise = (async () => {
      const response = await send(request, rpcOptions)

      if (
        !response ||
        typeof response !== 'object' ||
        !('type' in response) ||
        response.type !== 'finetune'
      ) {
        throw new InvalidResponseError('finetune')
      }

      return finetuneResponseSchema.parse(response)
    })()

    resultPromise.catch(() => {})

    return resultPromise
  }

  const runParams = parseClientInput(finetuneRunParamsSchema, params)
  // Client-side id so the run is cancellable via cancel({ requestId }) the
  // moment the handle is returned. Surfaced on the handle below.
  const requestId = generateClientRequestId()

  let resultResolver: (value: FinetuneResult) => void = () => {}
  let resultRejecter: (error: unknown) => void = () => {}
  const resultPromise = new Promise<FinetuneResult>((resolve, reject) => {
    resultResolver = resolve
    resultRejecter = reject
  })

  resultPromise.catch(() => {})

  const progressQueue: FinetuneProgress[] = []
  let progressDone = false
  let progressResolve: (() => void) | null = null
  let streamError: Error | null = null

  const processResponses = async () => {
    try {
      let sawTerminalResponse = false
      const request = parseClientInput(finetuneRunRequestSchema, {
        type: 'finetune',
        ...runParams,
        requestId,
        withProgress: true
      })
      const responses: AsyncGenerator<unknown> = streamRpc(request, rpcOptions)

      for await (const response of responses) {
        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'finetune:progress'
        ) {
          const progressResponse = finetuneProgressResponseSchema.parse(response)
          progressQueue.push({
            is_train: progressResponse.is_train,
            loss: progressResponse.loss,
            loss_uncertainty: progressResponse.loss_uncertainty,
            accuracy: progressResponse.accuracy,
            accuracy_uncertainty: progressResponse.accuracy_uncertainty,
            global_steps: progressResponse.global_steps,
            current_epoch: progressResponse.current_epoch,
            current_batch: progressResponse.current_batch,
            total_batches: progressResponse.total_batches,
            elapsed_ms: progressResponse.elapsed_ms,
            eta_ms: progressResponse.eta_ms
          })

          if (progressResolve) {
            progressResolve()
            progressResolve = null
          }
          continue
        }

        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'finetune'
        ) {
          sawTerminalResponse = true
          const finetuneResponse = finetuneResponseSchema.parse(response)
          resultResolver(finetuneResponse)
          progressDone = true
          if (progressResolve) {
            progressResolve()
            progressResolve = null
          }
        } else {
          throw new InvalidResponseError('finetune')
        }
      }

      if (!sawTerminalResponse) {
        throw new StreamEndedError()
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error))
      resultRejecter(error)
      progressDone = true
      if (progressResolve) {
        progressResolve()
        progressResolve = null
      }
    }
  }

  void processResponses()

  const progressStream = (async function* () {
    while (true) {
      if (progressQueue.length > 0) {
        yield progressQueue.shift()!
      } else if (progressDone) {
        if (streamError !== null) {
          throw streamError as Error
        }
        break
      } else {
        await new Promise<void>((resolve) => {
          progressResolve = resolve
        })
      }
    }
  })()

  return {
    progressStream,
    result: resultPromise,
    requestId
  }
}
