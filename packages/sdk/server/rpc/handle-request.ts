import {
  requestSchema,
  normalizeModelType,
  PROFILING_KEY,
  type CanonicalModelType,
  type Request,
  type ProfilingRequestMeta,
} from "@/schemas";
import { nowMs } from "@/profiling";
import { resolveModelConfig } from "@/server/bare/registry/model-config-registry";
import type RPC from "bare-rpc";
import {
  sendErrorResponse,
  sendStreamErrorResponse,
} from "@/server/error-handlers";
import {
  RPCUnknownRequestTypeError,
  PluginHandlerTypeMismatchError,
} from "@/utils/errors-server";
import { registry } from "./handler-registry";
import type { HandlerEntry } from "./handler-utils";
import {
  executeHandler,
  executeDuplexHandler,
  handleInitConfig,
  isInitConfigMessage,
} from "./handler-utils";
import { createServerProfiler, type ServerProfiler } from "./profiling";
import { assertLifecycleAllowed } from "@/server/bare/runtime-lifecycle";
import { shouldUseStreamErrorTransport } from "./transport-selector";

export async function handleRequest(req: RPC.IncomingRequest): Promise<void> {
  let profiler: ServerProfiler | undefined;
  let validationStart = 0;
  let rawRequest: Record<string, unknown> | undefined;
  let entry: HandlerEntry | undefined;

  try {
    const rawData = req.data?.toString();

    // Duplex stream request: metadata arrives as the first chunk on the
    // request stream (client used createRequestStream instead of send).
    if (!rawData) {
      await handleDuplexRequest(req);
      return;
    }

    // Timing runs unconditionally since we can't know if client
    // requested profiling until after parsing.
    const parseStart = nowMs();
    const jsonData: unknown = JSON.parse(rawData);
    const jsonParseMs = nowMs() - parseStart;

    // Handle internal config initialization (bypasses schema)
    if (isInitConfigMessage(jsonData)) {
      handleInitConfig(req, jsonData);
      return;
    }

    const { data: cleanData, profilingMeta } = extractProfilingMeta(jsonData);

    if (cleanData && typeof cleanData === "object") {
      rawRequest = cleanData as Record<string, unknown>;
      const rawType = rawRequest["type"];
      if (typeof rawType === "string") {
        entry = registry[rawType];
      }
    }

    profiler = createServerProfiler(profilingMeta);
    profiler.markRequestParsed(jsonParseMs);

    validationStart = nowMs();
    const processedData = applyDeviceDefaultsToRequest(cleanData);
    const request: Request = requestSchema.parse(processedData);
    attachProfilingMetaToRequest(request, profilingMeta);
    profiler.markRequestValidated(nowMs() - validationStart);
    validationStart = 0;

    assertLifecycleAllowed(request);

    entry = registry[request.type];
    if (!entry) {
      throw new RPCUnknownRequestTypeError(request.type);
    }

    await executeHandler(req, request, entry, profiler);
  } catch (error) {
    if (profiler && validationStart > 0) {
      profiler.markRequestValidated(nowMs() - validationStart);
    }

    if (shouldUseStreamErrorTransport(entry, rawRequest)) {
      sendStreamErrorResponse(req.createResponseStream(), error, profiler);
    } else {
      sendErrorResponse(req, error, profiler);
    }
  }
}

function attachProfilingMetaToRequest(
  request: Request,
  profilingMeta?: ProfilingRequestMeta,
): void {
  if (!profilingMeta) return;

  Object.defineProperty(request, PROFILING_KEY, {
    value: profilingMeta,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

function extractProfilingMeta(data: unknown): {
  data: unknown;
  profilingMeta: ProfilingRequestMeta | undefined;
} {
  if (!data || typeof data !== "object" || !(PROFILING_KEY in data)) {
    return { data, profilingMeta: undefined };
  }

  const obj = data as Record<string, unknown>;
  const { [PROFILING_KEY]: meta, ...rest } = obj;

  return {
    data: rest,
    profilingMeta: meta as ProfilingRequestMeta | undefined,
  };
}

async function handleDuplexRequest(req: RPC.IncomingRequest): Promise<void> {
  const inputStream = req.createRequestStream();
  const outputStream = req.createResponseStream();
  let profiler: ServerProfiler | undefined;

  try {
    const firstChunk = await new Promise<Buffer>((resolve, reject) => {
      const onData = (data: unknown) => {
        inputStream.off("error", onError);
        inputStream.pause();
        resolve(data as Buffer);
      };
      const onError = (err: unknown) => {
        inputStream.off("data", onData);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      inputStream.once("data", onData);
      inputStream.once("error", onError);
    });

    const parseStart = nowMs();
    const jsonData: unknown = JSON.parse(firstChunk.toString());
    const jsonParseMs = nowMs() - parseStart;

    const { data: cleanData, profilingMeta } = extractProfilingMeta(jsonData);
    profiler = createServerProfiler(profilingMeta);
    profiler.markRequestParsed(jsonParseMs);

    const validationStart = nowMs();
    const processedData = applyDeviceDefaultsToRequest(cleanData);
    const request: Request = requestSchema.parse(processedData);
    attachProfilingMetaToRequest(request, profilingMeta);
    profiler.markRequestValidated(nowMs() - validationStart);

    assertLifecycleAllowed(request);

    const entry = registry[request.type];

    if (!entry) {
      throw new RPCUnknownRequestTypeError(request.type);
    }

    if (entry.type !== "duplex") {
      throw new PluginHandlerTypeMismatchError(
        request.type,
        "duplex",
        entry.type,
      );
    }

    await executeDuplexHandler(
      req,
      request,
      entry,
      inputStream,
      outputStream,
      profiler,
    );
  } catch (error) {
    inputStream.destroy();
    sendStreamErrorResponse(outputStream, error, profiler);
  }
}

/**
 * Apply device-specific config defaults to loadModel requests before schema parsing.
 * This ensures device defaults are applied before schema defaults.
 *
 * Priority: User config > Device defaults > Schema defaults
 */
function applyDeviceDefaultsToRequest(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;

  const obj = data as Record<string, unknown>;
  const requestType = obj["type"];

  // Only process loadModel requests (not reload config which uses modelId)
  if (
    requestType !== "loadModel" ||
    !obj["modelType"] ||
    !("modelSrc" in obj)
  ) {
    return data;
  }

  // Normalize model type to canonical form
  let canonicalType: CanonicalModelType;
  try {
    canonicalType = normalizeModelType(
      obj["modelType"] as string,
    ) as CanonicalModelType;
  } catch {
    // Invalid model type, let schema validation handle it
    return data;
  }

  // Apply device defaults and full schema defaults to modelConfig
  const rawConfig = (obj["modelConfig"] as Record<string, unknown>) ?? {};
  const configWithDefaults = resolveModelConfig(canonicalType, rawConfig);

  return {
    ...obj,
    modelConfig: configWithDefaults,
  };
}
