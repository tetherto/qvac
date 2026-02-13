/**
 * Server-side RPC transport for delegated requests.
 *
 * This module provides `send` and `stream` functions for server-side
 * delegation to remote peers (via HyperSwarm RPC).
 */

import type RPC from "bare-rpc";
import {
  requestSchema,
  responseSchema,
  type Request,
  type Response,
  type RPCOptions,
} from "@/schemas";
import { withTimeout, withTimeoutStream } from "@/utils/withTimeout";
import { getServerLogger } from "@/logging";
import { DelegateProviderError } from "@/utils/errors-server";

const logger = getServerLogger();

let commandCounter = 0;

function getNextCommandId() {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER;
  return commandCounter;
}

function checkAndThrowError(response: Response): void {
  if (response.type === "error") {
    throw new DelegateProviderError(
      response.message || "Unknown provider error",
      response.code,
    );
  }
}

export async function send<T extends Request>(
  request: T,
  rpc: RPC,
  options?: RPCOptions,
): Promise<Response> {
  const parsedRequest = requestSchema.parse(request);
  const req = rpc.request(getNextCommandId());

  logger.debug("[delegate-transport] Sending:", { type: request.type });

  const payload = JSON.stringify(parsedRequest);
  req.send(payload, "utf-8");

  const response = await withTimeout(req.reply("utf-8"), options?.timeout);

  const resPayload = responseSchema.parse(
    JSON.parse(response?.toString() || "{}"),
  );
  logger.debug("[delegate-transport] Response:", { type: resPayload.type });

  checkAndThrowError(resPayload);

  return resPayload;
}

export async function* stream<T extends Request>(
  request: T,
  rpc: RPC,
  options: RPCOptions = {},
): AsyncGenerator<Response> {
  const parsedRequest = requestSchema.parse(request);
  const req = rpc.request(getNextCommandId());

  logger.debug("[delegate-transport] Streaming:", { type: request.type });

  req.send(JSON.stringify(parsedRequest), "utf-8");

  const responseStream = req.createResponseStream({ encoding: "utf-8" });
  let buffer = "";

  async function* processStream(): AsyncGenerator<Buffer> {
    for await (const chunk of responseStream as AsyncIterable<Buffer>) {
      yield chunk;
    }
  }

  const streamWithTimeout = withTimeoutStream(
    processStream(),
    options?.timeout,
  );

  for await (const chunk of streamWithTimeout) {
    buffer += chunk.toString();

    // Process complete lines (newline-delimited JSON)
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        const response = responseSchema.parse(JSON.parse(line));

        checkAndThrowError(response);

        yield response;
      }
    }
  }
}
