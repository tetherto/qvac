import type {
  Request,
  Response,
  QvacConfig,
  RuntimeContext,
  CanonicalModelType,
} from "@/schemas";
import { normalizeModelType } from "@/schemas";
import os from "bare-os";
import { handlers } from "@/server/rpc/handlers";
import {
  RPCNoHandlerError,
  RPCRequestNotSentError,
} from "@/utils/errors-client";
import { initializeConfig } from "@/client/init-hooks";
import { setSDKConfig } from "@/server/bare/registry/config-registry";
import { setRuntimeContext } from "@/server/bare/registry/runtime-context-registry";
import { resolveModelConfig } from "@/server/bare/registry/model-config-registry";
import { resolveConfig } from "@/client/config-loader/resolve-config.bare";

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
    canonicalType = normalizeModelType(
      request.modelType as Parameters<typeof normalizeModelType>[0],
    );
  } catch {
    return request;
  }

  const rawConfig = (request.modelConfig as Record<string, unknown>) ?? {};
  const configWithDefaults = resolveModelConfig(canonicalType, rawConfig);

  return { ...request, modelConfig: configWithDefaults } as T;
}

async function send<T extends Request>(request: T): Promise<Response> {
  if (request.type === "ping") {
    return { type: "pong", number: Math.random() * 100 };
  }

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

const createMockRPCRequest = () => {
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
};

let configInitialized = false;

export async function getRPC() {
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

export function close() {
  // noop
}
