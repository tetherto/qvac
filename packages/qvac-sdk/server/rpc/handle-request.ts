import {
  requestSchema,
  normalizeModelType,
  type CanonicalModelType,
  type Request,
} from "@/schemas";
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

export async function handleRequest(req: RPC.IncomingRequest): Promise<void> {
  try {
    const rawData = req.data?.toString();
    if (!rawData) {
      throw new RPCNoDataReceivedError();
    }
    const jsonData: unknown = JSON.parse(rawData);

    // Handle internal config initialization (bypasses schema)
    if (isInitConfigMessage(jsonData)) {
      handleInitConfig(req, jsonData);
      return;
    }

    const processedData = applyDeviceDefaultsToRequest(jsonData);
    const request: Request = requestSchema.parse(processedData);
    const entry = registry[request.type];

    if (!entry) {
      throw new RPCUnknownRequestTypeError(request.type);
    }

    await executeHandler(req, request, entry);
  } catch (error) {
    sendErrorResponse(req, error);
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
