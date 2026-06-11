import type {
  Request,
  Response,
  RuntimeContext,
  CanonicalModelType,
  ProfilingRequestMeta,
} from "@/schemas";
import { normalizeModelType, PROFILING_KEY } from "@/schemas";
import os from "bare-os";
import type { Readable } from "bare-stream";
import { registry } from "@/server/rpc/handler-registry";
import type { HandlerEntry } from "@/server/rpc/handler-utils";
import {
  handlerSupportsProgress,
  selectHandler,
} from "@/server/rpc/handler-selection";
import { createErrorResponse } from "@/schemas";
import {
  RPCNoHandlerError,
  RPCRequestNotSentError,
} from "@/utils/errors-client";
import { initializeConfig } from "@/client/init-hooks";
import { setSDKConfig } from "@/server/bare/registry/config-registry";
import { setRuntimeContext } from "@/server/bare/registry/runtime-context-registry";
import { resolveModelConfig } from "@/server/bare/registry/model-config-registry";
import { resolveConfig } from "@/client/config-loader/resolve-config.bare";
import {
  initializeWorkerCore,
  cleanupForTerminate,
} from "@/server/worker-core";
import { assertLifecycleAllowed } from "@/server/bare/runtime-lifecycle";
import { ensurePluginsRegistered } from "@/client/rpc/ensure-worker-ready";

async function ensureWorkerReady() {
  initializeWorkerCore();
  await ensurePluginsRegistered();
}

// Handler function types
type Handler =
  | ((
      req: Request,
      arg?: ((update: Response) => void) | DirectHandlerOptions,
    ) => Promise<Response> | Response)
  | ((
      req: Request,
      arg?: ((update: Response) => void) | DirectHandlerOptions,
    ) => AsyncGenerator<Response>);

type HandlerResult = Promise<Response> | Response | AsyncGenerator<Response>;

interface DirectHandlerOptions {
  progressCallback?: (update: Response) => void;
  profilingMeta?: ProfilingRequestMeta;
}

function getHandlerEntry(type: string): HandlerEntry {
  const entry = registry[type];
  if (!entry) {
    throw new RPCNoHandlerError(type);
  }
  return entry;
}

function applyDeviceDefaultsToLoadModel<T extends Request>(request: T): T {
  if (request.type !== "loadModel" || !("modelSrc" in request)) {
    return request;
  }

  let canonicalType: CanonicalModelType;
  try {
    canonicalType = normalizeModelType(request.modelType) as CanonicalModelType;
  } catch {
    return request;
  }

  const rawConfig = (request.modelConfig as Record<string, unknown>) ?? {};
  const configWithDefaults = resolveModelConfig(canonicalType, rawConfig);

  return { ...request, modelConfig: configWithDefaults };
}

function getProfilingMetaFromRequest(
  request: Request,
): ProfilingRequestMeta | undefined {
  if (PROFILING_KEY in request) {
    return (request as Record<string, unknown>)[
      PROFILING_KEY
    ] as ProfilingRequestMeta;
  }
  return undefined;
}

function createDelegatedOptions(
  request: Request,
  progressCallback?: (update: Response) => void,
): DirectHandlerOptions | undefined {
  const profilingMeta = getProfilingMetaFromRequest(request);
  if (!profilingMeta && !progressCallback) {
    return undefined;
  }

  const options: DirectHandlerOptions = {};
  if (progressCallback) {
    options.progressCallback = progressCallback;
  }
  if (profilingMeta) {
    options.profilingMeta = profilingMeta;
  }
  return options;
}

function executeDirectHandler(
  request: Request,
  handler: HandlerEntry["handler"],
  isDelegated: boolean,
): HandlerResult {
  const directHandler = handler as Handler;
  if (isDelegated) {
    return directHandler(request, createDelegatedOptions(request));
  }
  return directHandler(request);
}

function isAsyncGenerator(
  result: HandlerResult,
): result is AsyncGenerator<Response> {
  return (
    typeof result === "object" &&
    result !== null &&
    Symbol.asyncIterator in result
  );
}

async function* streamWithProgress(
  request: Request,
  handler: HandlerEntry["handler"],
  isDelegated: boolean,
) {
  const queue: Response[] = [];
  const errors: Error[] = [];
  let done = false;
  function progressCallback(update: Response) {
    queue.push(update);
  }
  const directHandler = handler as Handler;

  Promise.resolve(
    directHandler(
      request,
      isDelegated
        ? createDelegatedOptions(request, progressCallback)
        : progressCallback,
    ) as Promise<Response> | Response,
  )
    .then((final) => {
      queue.push(final);
      done = true;
    })
    .catch((error: Error) => {
      errors.push(error);
      done = true;
    });

  while (!done || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift()!;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const handlerError = errors[0];
  if (handlerError) {
    throw handlerError;
  }
}

export async function send<T extends Request>(request: T): Promise<Response> {
  assertLifecycleAllowed(request);

  const processedRequest = applyDeviceDefaultsToLoadModel(request);
  const entry = getHandlerEntry(processedRequest.type);
  const { handler, isDelegated } = selectHandler(entry, processedRequest);
  return (await executeDirectHandler(
    processedRequest,
    handler,
    isDelegated,
  )) as Response;
}

async function* stream<T extends Request>(request: T) {
  assertLifecycleAllowed(request);

  const processedRequest = applyDeviceDefaultsToLoadModel(request);
  const entry = getHandlerEntry(processedRequest.type);
  const { handler, isDelegated } = selectHandler(entry, processedRequest);

  if (handlerSupportsProgress(entry, processedRequest)) {
    yield* streamWithProgress(processedRequest, handler, isDelegated);
  } else {
    const result = executeDirectHandler(processedRequest, handler, isDelegated);

    // Check if the handler returns a Promise or AsyncGenerator
    if (isAsyncGenerator(result)) {
      // It's an AsyncGenerator
      yield* result;
    } else {
      // It's a Promise, await and yield the single result
      yield await result;
    }
  }
}

function createMockRPCRequest() {
  let requestData: Request | { type: string; config: unknown } | null = null;

  return {
    send(payload: string) {
      // Parse the JSON payload to get the actual request data
      requestData = JSON.parse(payload) as
        | Request
        | { type: string; config: unknown };
    },

    async reply() {
      if (!requestData) {
        throw new RPCRequestNotSentError();
      }

      // Handle special internal config initialization message
      if (
        typeof requestData === "object" &&
        "type" in requestData &&
        requestData.type === "__init_config"
      ) {
        try {
          const initData = requestData as {
            type: string;
            config: unknown;
            runtimeContext?: RuntimeContext;
          };
          if (initData.config) {
            setSDKConfig(initData.config);
          }
          if (initData.runtimeContext) {
            setRuntimeContext(initData.runtimeContext);
          }
          return Buffer.from(JSON.stringify({ success: true }));
        } catch (error) {
          return Buffer.from(
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }

      // Handle special pre-terminate cleanup signal. In direct mode the
      // bare runtime is the host JS context, so we run cleanup but never
      // exit the process here.
      if (
        typeof requestData === "object" &&
        "type" in requestData &&
        requestData.type === "__shutdown__"
      ) {
        try {
          await cleanupForTerminate();
          return Buffer.from(JSON.stringify({ success: true }));
        } catch (error) {
          return Buffer.from(
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }

      const response = await send(requestData as Request);
      return Buffer.from(JSON.stringify(response));
    },

    async *createResponseStream() {
      if (!requestData) {
        throw new RPCRequestNotSentError();
      }

      for await (const response of stream(requestData as Request)) {
        yield Buffer.from(JSON.stringify(response) + "\n");
      }
    },
  };
}

let configInitialized = false;

// No child worker on Bare-direct — `#rpc` interface stub.
export function getWorkerLifeSignal(): AbortSignal | null {
  return null;
}

export async function getRPC() {
  await ensureWorkerReady();

  const mockRPC = {
    request() {
      return createMockRPCRequest();
    },
  };

  // Initialize config once on first call
  if (!configInitialized) {
    const runtimeContext: RuntimeContext = {
      runtime: "bare",
      platform: os.platform(),
    };
    await initializeConfig(mockRPC, resolveConfig, runtimeContext);
    configInitialized = true;
  }

  return mockRPC;
}

export async function close() {
  await cleanupForTerminate();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function createDuplexSession(payload: string, _commandId: number) {
  await getRPC();

  const { PassThrough } = await import("bare-stream");
  const request = JSON.parse(payload) as Request;

  assertLifecycleAllowed(request);

  const entry = registry[request.type];
  if (!entry || entry.type !== "duplex") {
    throw new RPCNoHandlerError(request.type);
  }

  const inputStream = new PassThrough();
  const outputStream = new PassThrough();

  const duplexHandler = entry.handler as (
    req: Request,
    stream: Readable,
  ) => AsyncGenerator<Response>;

  void (async () => {
    try {
      for await (const response of duplexHandler(request, inputStream)) {
        outputStream.write(JSON.stringify(response) + "\n", "utf-8");
      }
    } catch (error) {
      inputStream.destroy();
      const errorResponse = createErrorResponse(error);
      outputStream.write(JSON.stringify(errorResponse) + "\n", "utf-8");
    } finally {
      outputStream.end();
    }
  })();

  return {
    requestStream: inputStream,
    responseStream: outputStream,
  };
}
