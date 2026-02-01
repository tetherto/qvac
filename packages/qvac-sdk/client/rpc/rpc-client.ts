import type RPC from "bare-rpc";
import {
  requestSchema,
  responseSchema,
  type Request,
  type Response,
  type RPCOptions,
} from "@/schemas";
import { RPCError } from "./rpc-error";
import { withTimeout, withTimeoutStream } from "@/utils/withTimeout";
import { isReactNative, isBare } from "@/utils/runtime";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

let rpcInstance: RPC | null = null;
let commandCounter = 0;

function getNextCommandId() {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER;
  return commandCounter;
}

function checkAndThrowError(response: Response): void {
  if (response.type === "error") {
    throw new RPCError(response);
  }
}

async function getRPC(): Promise<RPC> {
  if (rpcInstance) return rpcInstance;

  const isRN = isReactNative();
  const isBareRuntime = isBare();

  // TODO Lots of type unsafe hacks to make this work cross platform
  if (isRN) {
    logger.debug("React Native runtime detected");
    // Only import expo client for React Native - Metro won't bundle the Node client
    const expoRPCClientPath = "./expo-rpc-client";
    const mod = (await import(expoRPCClientPath)) as
      | { getRPC: () => RPC | Promise<RPC> }
      | (() => RPC | Promise<RPC>);
    rpcInstance = await (typeof mod === "function" ? mod() : mod.getRPC());
    return rpcInstance;
  } else if (isBareRuntime) {
    logger.debug("Bare runtime detected");
    // Use dynamic import for Bare client
    const mod = await import("./bare-client");
    rpcInstance = (await mod.getRPC()) as unknown as RPC;
    return rpcInstance;
  } else {
    logger.debug("Node runtime detected");
    // Use dynamic import for Node client to prevent Metro from bundling it
    const mod = await import("./node-rpc-client");
    rpcInstance = mod.getRPC() as unknown as RPC;
    return rpcInstance;
  }
}

export async function send<T extends Request>(
  request: T,
  rpc?: RPC,
  options?: RPCOptions,
): Promise<Response> {
  const parsedRequest = requestSchema.parse(request);
  const rpcInstance = rpc || (await getRPC());
  const req = rpcInstance.request(getNextCommandId());
  // TODO temp for debugging, find a better solution to exclude large payloads
  // Log request type and basic info, avoid logging large payloads
  if (request.type === "transcribeStream") {
    logger.debug("RPC Client sending:", {
      type: request.type,
      modelId: request.modelId,
      audioChunkType: request.audioChunk.type,
      audioChunkSize: request.audioChunk.value.length,
    });
  } else {
    logger.debug("RPC Client sending:", request);
  }
  const payload = JSON.stringify(parsedRequest);
  req.send(payload, "utf-8");

  const response = await withTimeout(req.reply("utf-8"), options?.timeout);

  const resPayload = responseSchema.parse(
    JSON.parse(response?.toString() || "{}"),
  );
  logger.debug("ResPayload", { type: resPayload.type });

  checkAndThrowError(resPayload);

  return resPayload;
}

export async function* stream<T extends Request>(
  request: T,
  rpc?: RPC,
  options: RPCOptions = {},
): AsyncGenerator<Response> {
  const parsedRequest = requestSchema.parse(request);
  const rpcInstance = rpc || (await getRPC());
  const req = rpcInstance.request(getNextCommandId());
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

export async function close() {
  if (!rpcInstance) return;

  const isRN = isReactNative();
  const isBareRuntime = isBare();

  if (isRN) {
    const mod = (await import("./expo-rpc-client")) as { close: () => void };
    mod.close();
  } else if (isBareRuntime) {
    // Bare runs in-process (no separate worker), so no cleanup needed
  } else {
    const mod = (await import("./node-rpc-client")) as { close: () => void };
    mod.close();
  }

  rpcInstance = null;
}
