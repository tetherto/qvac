import { stream as streamRpc } from "@/client/rpc/rpc-client";
import {
  finetuneResponseSchema,
  finetuneProgressSchema,
  type FinetuningOptions,
  type FinetuneResponse,
  type FinetuneProgress,
  type RPCOptions,
} from "@/schemas";

type FinetuneStartParams = FinetuningOptions & {
  op?: "start";
  modelId: string;
  rpcOptions?: RPCOptions;
};

type FinetunePauseParams = {
  op: "pause";
  modelId: string;
  rpcOptions?: RPCOptions;
};

type FinetuneCancelParams = {
  op: "cancel";
  modelId: string;
  rpcOptions?: RPCOptions;
};

export interface FinetuneHandle {
  progressStream: AsyncGenerator<FinetuneProgress>;
  result: Promise<FinetuneResponse>;
}

export function finetune(params: FinetunePauseParams): Promise<FinetuneResponse>;
export function finetune(params: FinetuneCancelParams): Promise<FinetuneResponse>;
export function finetune(params: FinetuneStartParams): FinetuneHandle;
export function finetune(
  params: FinetuneStartParams | FinetunePauseParams | FinetuneCancelParams,
): FinetuneHandle | Promise<FinetuneResponse> {
  const op = params.op ?? "start";

  if (op === "pause" || op === "cancel") {
    return finetuneControl(params as FinetunePauseParams | FinetuneCancelParams);
  }

  return finetuneStart(params as FinetuneStartParams);
}

function finetuneStart(params: FinetuneStartParams): FinetuneHandle {
  const { rpcOptions, ...rest } = params;

  let resultResolver: (value: FinetuneResponse) => void = () => {};
  let resultRejecter: (error: unknown) => void = () => {};
  const resultPromise = new Promise<FinetuneResponse>((resolve, reject) => {
    resultResolver = resolve;
    resultRejecter = reject;
  });

  resultPromise.catch(() => {});

  const progressQueue: FinetuneProgress[] = [];
  let progressDone = false;
  let progressResolve: (() => void) | null = null;
  let streamError: Error | null = null;

  const processResponses = async () => {
    const request = {
      type: "finetune" as const,
      op: "start" as const,
      ...rest,
    };

    const responses: AsyncGenerator<unknown> = streamRpc(request, rpcOptions);

    for await (const response of responses) {
      if (!response || typeof response !== "object" || !("type" in response)) {
        continue;
      }

      if (response.type === "finetuneProgress") {
        const progress = finetuneProgressSchema.parse(response);
        progressQueue.push(progress);
        if (progressResolve) {
          progressResolve();
          progressResolve = null;
        }
      } else if (response.type === "finetune") {
        const result = finetuneResponseSchema.parse(response);
        resultResolver(result);
        progressDone = true;
        if (progressResolve) {
          progressResolve();
          progressResolve = null;
        }
      }
    }

    if (!progressDone) {
      progressDone = true;
      if (progressResolve) {
        progressResolve();
        progressResolve = null;
      }
    }
  };

  void processResponses().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    streamError = err;
    resultRejecter(err);
    progressDone = true;
    if (progressResolve) {
      progressResolve();
      progressResolve = null;
    }
  });

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

async function finetuneControl(
  params: FinetunePauseParams | FinetuneCancelParams,
): Promise<FinetuneResponse> {
  const { rpcOptions, ...rest } = params;
  const fallbackStatus = params.op === "pause" ? "PAUSED" : "CANCELLED";
  const responses = streamRpc(
    { type: "finetune" as const, ...rest },
    rpcOptions,
  );
  for await (const response of responses) {
    if (response && typeof response === "object" && "type" in response && response.type === "finetune") {
      return finetuneResponseSchema.parse(response);
    }
  }
  return { type: "finetune", status: fallbackStatus };
}
