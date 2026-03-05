import {
  responseSchema,
  type QvacConfig,
  type Request,
  type Response,
  type RuntimeContext,
} from "@/schemas";
import type RPC from "bare-rpc";
import {
  sendErrorResponse,
  sendStreamErrorResponse,
} from "@/server/error-handlers";
import { setSDKConfig } from "@/server/bare/registry/config-registry";
import { setRuntimeContext } from "@/server/bare/registry/runtime-context-registry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReplyHandler = (request: any) => Promise<Response> | Response;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamHandler = (request: any) => AsyncGenerator<Response>;
type ProgressHandler = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any,
  onProgress?: (update: Response) => void,
) => Promise<Response>;

export type HandlerEntry = {
  type: "reply" | "stream";
  handler: ReplyHandler | StreamHandler | ProgressHandler;
  delegatedHandler?: ReplyHandler | StreamHandler | ProgressHandler;
  isDelegated?: (request: Request) => boolean;
  supportsProgress?: boolean | ((request: Request) => boolean);
};

function writeToStream(
  stream: ReturnType<RPC.IncomingRequest["createResponseStream"]>,
  response: Response,
) {
  stream.write(JSON.stringify(responseSchema.parse(response)) + "\n", "utf-8");
}

async function executeReplyHandler(
  req: RPC.IncomingRequest,
  request: Request,
  handler: ReplyHandler,
) {
  try {
    const response = await handler(request);
    req.reply(JSON.stringify(responseSchema.parse(response)), "utf-8");
  } catch (error) {
    sendErrorResponse(req, error);
  }
}

async function executeStreamHandler(
  req: RPC.IncomingRequest,
  request: Request,
  handler: StreamHandler,
) {
  const stream = req.createResponseStream();
  try {
    for await (const response of handler(request)) {
      stream.write(
        JSON.stringify(responseSchema.parse(response)) + "\n",
        "utf-8",
      );
    }
    stream.end();
  } catch (error) {
    sendStreamErrorResponse(stream, error);
  }
}

async function executeProgressHandler(
  req: RPC.IncomingRequest,
  request: Request,
  handler: ProgressHandler,
) {
  const stream = req.createResponseStream();
  try {
    const response = await handler(request, (update) =>
      writeToStream(stream, update),
    );
    writeToStream(stream, response);
    stream.end();
  } catch (error) {
    sendStreamErrorResponse(stream, error);
  }
}

// Unified handler executor with delegation and progress support
export async function executeHandler(
  req: RPC.IncomingRequest,
  request: Request,
  entry: HandlerEntry,
) {
  const handler =
    entry.delegatedHandler && entry.isDelegated?.(request)
      ? entry.delegatedHandler
      : entry.handler;

  const wantsProgress =
    "withProgress" in request &&
    request.withProgress &&
    (typeof entry.supportsProgress === "function"
      ? entry.supportsProgress(request)
      : entry.supportsProgress);

  try {
    if (entry.type === "stream") {
      await executeStreamHandler(req, request, handler as StreamHandler);
    } else if (wantsProgress) {
      await executeProgressHandler(req, request, handler as ProgressHandler);
    } else {
      await executeReplyHandler(req, request, handler as ReplyHandler);
    }
  } catch (error) {
    sendErrorResponse(req, error);
  }
}

// Internal config initialization (bypasses schema)
type InitConfigMessage = {
  type: "__init_config";
  config: QvacConfig;
  runtimeContext?: RuntimeContext;
};

export function isInitConfigMessage(data: unknown): data is InitConfigMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "__init_config"
  );
}

export function handleInitConfig(
  req: RPC.IncomingRequest,
  data: InitConfigMessage,
) {
  try {
    if (data.config) {
      setSDKConfig(data.config);
    }
    if (data.runtimeContext) {
      setRuntimeContext(data.runtimeContext);
    }
    req.reply(JSON.stringify({ success: true }), "utf-8");
  } catch (error) {
    req.reply(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      "utf-8",
    );
  }
}
