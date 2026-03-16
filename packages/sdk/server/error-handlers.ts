import type RPC from "bare-rpc";
import { createErrorResponse, responseSchema } from "@/schemas";
import { getServerLogger } from "@/logging";
import { type ServerProfiler } from "./rpc/profiling";

const logger = getServerLogger();

function buildErrorResponseData(
  error: unknown,
  profiler?: ServerProfiler,
): string {
  const errorResponse = createErrorResponse(error);
  const validated = responseSchema.parse(errorResponse);
  const json = JSON.stringify(validated);
  return profiler ? profiler.serializeError(json) : json;
}

export function sendErrorResponse(
  req: RPC.IncomingRequest,
  error: unknown,
  profiler?: ServerProfiler,
) {
  try {
    req.reply(buildErrorResponseData(error, profiler), "utf-8");
  } catch (responseError) {
    logger.error("Failed to create error response:", responseError);
    const fallbackError = createErrorResponse(
      new Error("Internal server error"),
    );
    req.reply(JSON.stringify(fallbackError), "utf-8");
  }
}

export function sendStreamErrorResponse(
  stream: ReturnType<RPC.IncomingRequest["createResponseStream"]>,
  error: unknown,
  profiler?: ServerProfiler,
) {
  try {
    stream.write(buildErrorResponseData(error, profiler) + "\n", "utf-8");
    stream.end();
  } catch (responseError) {
    logger.error("Failed to create stream error response:", responseError);
    const fallbackError = createErrorResponse(
      new Error("Internal server error"),
    );
    stream.write(JSON.stringify(fallbackError) + "\n", "utf-8");
    stream.end();
  }
}
