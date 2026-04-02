import { send, stream as streamRpc } from "@/client/rpc/rpc-client";
import {
  finetuneProgressResponseSchema,
  finetuneResponseSchema,
  finetuneResumeParamsSchema,
  finetuneStartParamsSchema,
  type FinetuneCancelParams,
  type FinetuneParams,
  type FinetuneProgress,
  type FinetuneRequest,
  type FinetuneResult,
  type FinetunePauseParams,
  type FinetuneResumeParams,
  type RPCOptions,
  type FinetuneStartParams,
} from "@/schemas";
import {
  InvalidResponseError,
  StreamEndedError,
} from "@/utils/errors-client";

export interface FinetuneHandle {
  progressStream: AsyncGenerator<FinetuneProgress>;
  result: Promise<FinetuneResult>;
}

type FinetuneRunParams = FinetuneStartParams | FinetuneResumeParams;
type FinetuneControlParams = FinetunePauseParams | FinetuneCancelParams;
type FinetuneRunRequest = Extract<FinetuneRequest, { operation: "start" | "resume" }>;
type FinetuneControlRequest = Extract<
  FinetuneRequest,
  { operation: "pause" | "cancel" }
>;

/**
 * Starts, resumes, pauses, or cancels a finetuning job for a loaded model.
 *
 * @param params - The finetuning parameters
 * @param params.modelId - The identifier of the loaded model to finetune
 * @param params.operation - The finetuning operation. Defaults to `"start"` when omitted
 * @param params.options - Finetuning options for start and resume operations
 * @param params.options.trainDatasetDir - Directory containing the training dataset
 * @param params.options.validation - Validation configuration for the finetuning run
 * @param params.options.outputParametersDir - Directory where output adapter parameters are written
 * @param params.options.numberOfEpochs - Optional number of epochs to run
 * @param params.options.learningRate - Optional learning rate override
 * @param params.options.contextLength - Optional context length override
 * @param params.options.batchSize - Optional batch size override
 * @param params.options.microBatchSize - Optional micro batch size override
 * @param params.options.assistantLossOnly - Optional flag to compute loss only on assistant tokens
 * @param params.options.loraRank - Optional LoRA rank override
 * @param params.options.loraAlpha - Optional LoRA alpha override
 * @param params.options.loraInitStd - Optional LoRA initialization standard deviation
 * @param params.options.loraDropout - Optional LoRA dropout override
 * @param params.options.loraModules - Optional comma-separated LoRA module selection
 * @param params.options.checkpointSaveDir - Optional directory for checkpoint snapshots
 * @param params.options.checkpointSaveSteps - Optional checkpoint save interval
 * @param params.options.chatTemplatePath - Optional custom chat template path
 * @param params.options.lrScheduler - Optional learning rate scheduler
 * @param params.options.lrMin - Optional minimum learning rate
 * @param params.options.warmupRatio - Optional warmup ratio
 * @param params.options.warmupSteps - Optional warmup step count
 * @param params.options.weightDecay - Optional weight decay override
 * @param rpcOptions - Optional RPC transport options
 * @returns For `start` and `resume`, returns a handle with a `progressStream`
 *   generator and a terminal `result` promise. For `pause` and `cancel`,
 *   returns a promise that resolves to the terminal finetune result.
 * @example
 * ```typescript
 * const handle = finetune({
 *   modelId,
 *   options: {
 *     trainDatasetDir: "./dataset/train",
 *     validation: { type: "split", fraction: 0.05 },
 *     outputParametersDir: "./artifacts/lora",
 *     numberOfEpochs: 2,
 *   },
 * });
 *
 * for await (const progress of handle.progressStream) {
 *   console.log(progress.global_steps, progress.loss);
 * }
 *
 * console.log(await handle.result);
 *
 * const pauseResult = await finetune({ modelId, operation: "pause" });
 * console.log(pauseResult.status);
 * ```
 */
export function finetune(
  params: FinetuneRunParams,
  rpcOptions?: RPCOptions,
): FinetuneHandle;

export function finetune(
  params: FinetuneControlParams,
  rpcOptions?: RPCOptions,
): Promise<FinetuneResult>;

export function finetune(
  params: FinetuneParams,
  rpcOptions?: RPCOptions,
): FinetuneHandle | Promise<FinetuneResult> {
  if (params.operation === "pause" || params.operation === "cancel") {
    const request: FinetuneControlRequest = {
      type: "finetune",
      modelId: params.modelId,
      operation: params.operation,
    };

    const resultPromise = (async () => {
      const response = await send(request, rpcOptions);

      if (
        !response ||
        typeof response !== "object" ||
        !("type" in response) ||
        response.type !== "finetune"
      ) {
        throw new InvalidResponseError("finetune");
      }

      return finetuneResponseSchema.parse(response);
    })();

    resultPromise.catch(() => { });

    return resultPromise;
  }

  const runParams =
    params.operation === "resume"
      ? finetuneResumeParamsSchema.parse(params)
      : finetuneStartParamsSchema.parse(params);

  let resultResolver: (value: FinetuneResult) => void = () => { };
  let resultRejecter: (error: unknown) => void = () => { };
  const resultPromise = new Promise<FinetuneResult>((resolve, reject) => {
    resultResolver = resolve;
    resultRejecter = reject;
  });

  resultPromise.catch(() => { });

  const progressQueue: FinetuneProgress[] = [];
  let progressDone = false;
  let progressResolve: (() => void) | null = null;
  let streamError: Error | null = null;

  const processResponses = async () => {
    try {
      let sawTerminalResponse = false;
      const request: FinetuneRunRequest = {
        type: "finetune",
        ...runParams,
        operation: runParams.operation ?? "start",
        withProgress: true,
      };
      const responses: AsyncGenerator<unknown> = streamRpc(
        request,
        rpcOptions,
      );

      for await (const response of responses) {
        if (
          response &&
          typeof response === "object" &&
          "type" in response &&
          response.type === "finetune:progress"
        ) {
          const progressResponse = finetuneProgressResponseSchema.parse(response);
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
            eta_ms: progressResponse.eta_ms,
          });

          if (progressResolve) {
            progressResolve();
            progressResolve = null;
          }
          continue;
        }

        if (
          response &&
          typeof response === "object" &&
          "type" in response &&
          response.type === "finetune"
        ) {
          sawTerminalResponse = true;
          const finetuneResponse = finetuneResponseSchema.parse(response);
          resultResolver(finetuneResponse);
          progressDone = true;
          if (progressResolve) {
            progressResolve();
            progressResolve = null;
          }
        } else {
          throw new InvalidResponseError("finetune");
        }
      }

      if (!sawTerminalResponse) {
        throw new StreamEndedError();
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
      resultRejecter(error);
      progressDone = true;
      if (progressResolve) {
        progressResolve();
        progressResolve = null;
      }
    }
  };

  void processResponses();

  const progressStream = (async function* () {
    while (true) {
      if (progressQueue.length > 0) {
        yield progressQueue.shift()!;
      } else if (progressDone) {
        if (streamError !== null) {
          throw streamError as Error;
        }
        break;
      } else {
        await new Promise<void>((resolve) => {
          progressResolve = resolve;
        });
      }
    }
  })();

  return {
    progressStream,
    result: resultPromise,
  };
}
