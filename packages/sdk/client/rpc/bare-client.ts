import type {
  Request,
  Response,
  QvacConfig,
  RuntimeContext,
  CanonicalModelType,
} from "@/schemas";
import { normalizeModelType } from "@/schemas";
import os from "bare-os";
import type { Readable } from "bare-stream";
import { handlers } from "@/server/rpc/handlers";
import { registry } from "@/server/rpc/handler-registry";
import { createErrorResponse } from "@/schemas";
import {
  PearWorkerEntryRequiredError,
  RPCNoHandlerError,
  RPCRequestNotSentError,
} from "@/utils/errors-client";
import { initializeConfig } from "@/client/init-hooks";
import { setSDKConfig } from "@/server/bare/registry/config-registry";
import { setRuntimeContext } from "@/server/bare/registry/runtime-context-registry";
import { resolveModelConfig } from "@/server/bare/registry/model-config-registry";
import { resolveConfig } from "@/client/config-loader/resolve-config.bare";
import { getClientLogger } from "@/logging";
import { getAllPlugins } from "@/server/plugins";
import {
  initializeWorkerCore,
  shutdownBareDirectWorker,
} from "@/server/worker-core";

const logger = getClientLogger();

/**
 * Load worker entry to register plugins before any SDK calls.
 *
 * If plugins are already registered (e.g., by a Pear worker bootstrap),
 * skip loading the default worker but still initialize worker core.
 *
 * NOTE: For Pear apps, the fallback (loading default worker) cannot work.
 *
 * The default worker is intentionally excluded from `pear stage --compact`
 * to enable tree-shaking of unused built-in plugins. When a Pear app tries
 * to dynamically import it at runtime, the path resolves to a pear:// URL.
 * The default worker imports built-in plugins, which load native addons
 * (.bare files). Native addons cannot be loaded from pear:// URLs, causing
 * UNSUPPORTED_PROTOCOL errors.
 *
 * Instead, we detect Pear runtime and throw a clear error directing users
 * to use the generated worker entry (qvac/worker.pear.entry.mjs).
 *
 * The fallback only works in non-Pear environments.
 */
async function loadWorkerEntry() {
  initializeWorkerCore();

  if (getAllPlugins().length > 0) {
    logger.info("📦 Plugins already registered, worker core initialized");
    return;
  }

  const { isPear } = await import("which-runtime");
  if (isPear) {
    throw new PearWorkerEntryRequiredError("qvac/worker.pear.entry.mjs");
  }

  // Fallback: load default worker (all built-in plugins)
  logger.info("📦 Loading default worker (all built-in plugins)");
  const workerPath = "../../server/" + "worker.js";
  await import(workerPath);
}

let workerEntryLoaded = false;

// Handler function types
type Handler =
  | ((req: Request) => Promise<Response>)
  | ((req: Request) => AsyncGenerator<Response>);

// Get the handler for a request type
function getHandler(type: string): Handler | undefined {
  const handler = handlers[type as keyof typeof handlers];
  return typeof handler === "function" ? (handler as Handler) : undefined;
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

  return { ...request, modelConfig: configWithDefaults } as T;
}

export async function send<T extends Request>(request: T): Promise<Response> {
  const handler = getHandler(request.type);
  if (!handler) throw new RPCNoHandlerError(request.type);

  const processedRequest = applyDeviceDefaultsToLoadModel(request);
  return (await handler(processedRequest)) as Response;
}

async function* stream<T extends Request>(request: T) {
  const handler = getHandler(request.type);
  if (!handler) throw new RPCNoHandlerError(request.type);

  // Special handling for loadModel with progress
  if (
    request.type === "loadModel" &&
    "withProgress" in request &&
    request.withProgress
  ) {
    const processedRequest = applyDeviceDefaultsToLoadModel(request);

    async function* streamWithProgress() {
      const queue: Response[] = [];
      let done = false;

      const loadModelHandler = handler as (
        req: Request,
        callback: (update: Response) => void,
      ) => Promise<Response>;
      loadModelHandler(processedRequest, (update) => queue.push(update))
        .then((final) => {
          queue.push(final);
          done = true;
        })
        .catch((error) => {
          done = true;
          throw error;
        });

      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }

    yield* streamWithProgress();
  } else if (
    request.type === "downloadAsset" &&
    "withProgress" in request &&
    request.withProgress
  ) {
    async function* streamWithProgress() {
      const queue: Response[] = [];
      let done = false;

      const downloadAssetHandler = handler as (
        req: Request,
        callback: (update: Response) => void,
      ) => Promise<Response>;
      downloadAssetHandler(request, (update) => queue.push(update))
        .then((final) => {
          queue.push(final);
          done = true;
        })
        .catch((error) => {
          done = true;
          throw error;
        });

      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }

    yield* streamWithProgress();
  } else {
    const result = handler(request);

    // Check if the handler returns a Promise or AsyncGenerator
    if (Symbol.asyncIterator in result) {
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
            setSDKConfig(initData.config as QvacConfig);
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

export async function getRPC() {
  if (!workerEntryLoaded) {
    await loadWorkerEntry();
    workerEntryLoaded = true;
  }

  const mockRPC = {
    request() {
      return createMockRPCRequest();
    },
  };

  // Initialize config once on first call
  if (!configInitialized) {
    const runtimeContext: RuntimeContext = {
      runtime: "bare",
      platform: os.platform() as "darwin" | "linux" | "win32",
    };
    await initializeConfig(mockRPC, resolveConfig, runtimeContext);
    configInitialized = true;
  }

  return mockRPC;
}

export async function close() {
  await shutdownBareDirectWorker("rpc-close");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function createDuplexSession(payload: string, _commandId: number) {
  await getRPC();

  const { PassThrough } = await import("bare-stream");
  const request = JSON.parse(payload) as Request;

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
