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
import { getClientLogger, summarizeRequest } from "@/logging";
import { getRPC, close as closeRPC } from "#rpc";

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

async function getRPCInstance(): Promise<RPC> {
  if (rpcInstance) return rpcInstance;
  rpcInstance = await (getRPC() as unknown as Promise<RPC>);
  return rpcInstance;
}

export async function send<T extends Request>(
  request: T,
  rpc?: RPC,
  options?: RPCOptions,
): Promise<Response> {
  const parsedRequest = requestSchema.parse(request);
  const rpcInstance = rpc || (await getRPCInstance());
  const req = rpcInstance.request(getNextCommandId());
  logger.debug("RPC Client sending:", summarizeRequest(request));
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
  const rpcInstance = rpc || (await getRPCInstance());
  const req = rpcInstance.request(getNextCommandId());
  logger.debug("RPC Client streaming:", summarizeRequest(request));
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

export function close() {
  if (!rpcInstance) return;
  closeRPC();
  rpcInstance = null;
}
