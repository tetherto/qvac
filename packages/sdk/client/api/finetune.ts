import { stream as streamRpc } from "@/client/rpc/rpc-client";
import {
  finetuneResponseSchema,
  finetuneProgressSchema,
  type FinetuningOptions,
  type FinetuneRequest,
  type FinetuneResponse,
  type FinetuneProgress,
  type RPCOptions,
} from "@/schemas";

type FinetuneParams = FinetuningOptions & {
  modelId: string;
  rpcOptions?: RPCOptions;
};

export interface FinetuneHandle {
  progressStream: AsyncGenerator<FinetuneProgress>;
  result: Promise<FinetuneResponse>;
}

export function finetune(params: FinetuneParams): FinetuneHandle {
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
    const request: FinetuneRequest = {
      type: "finetune",
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

    // If we exited the loop without a finetune response, signal done
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
