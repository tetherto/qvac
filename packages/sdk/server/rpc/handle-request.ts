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
import { sendErrorResponse } from "@/server/error-handlers";
import {
  RPCNoDataReceivedError,
  RPCUnknownRequestTypeError,
} from "@/utils/errors-server";
import { registry } from "./handler-registry";
import {
  executeHandler,
  handleInitConfig,
  isInitConfigMessage,
} from "./handler-utils";
import { createServerProfiler, type ServerProfiler } from "./profiling";

export async function handleRequest(req: RPC.IncomingRequest): Promise<void> {
  let profiler: ServerProfiler | undefined;
  let validationStart = 0;

  try {
    const rawData = req.data?.toString();
    if (!rawData) {
      throw new RPCNoDataReceivedError();
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

    profiler = createServerProfiler(profilingMeta);
    profiler.markRequestParsed(jsonParseMs);

    validationStart = nowMs();
    const processedData = applyDeviceDefaultsToRequest(cleanData);
    const request: Request = requestSchema.parse(processedData);
    attachProfilingMetaToRequest(request, profilingMeta);
    profiler.markRequestValidated(nowMs() - validationStart);
    validationStart = 0;

    const entry = registry[request.type];
    if (!entry) {
      throw new RPCUnknownRequestTypeError(request.type);
    }

    await executeHandler(req, request, entry, profiler);
  } catch (error) {
    if (profiler && validationStart > 0) {
      profiler.markRequestValidated(nowMs() - validationStart);
    }
    sendErrorResponse(req, error, profiler);
  }
}

function attachProfilingMetaToRequest(
  request: Request,
  profilingMeta?: ProfilingRequestMeta,
): void {
  if (!profilingMeta) return;

  Object.defineProperty(request as Record<string, unknown>, PROFILING_KEY, {
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
