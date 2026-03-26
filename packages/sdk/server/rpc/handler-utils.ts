import {
  type QvacConfig,
  type Request,
  type Response,
  type RuntimeContext,
  type ProfilingRequestMeta,
  PROFILING_KEY,
} from "@/schemas";
import type RPC from "bare-rpc";
import {
  sendErrorResponse,
  sendStreamErrorResponse,
} from "@/server/error-handlers";
import { setSDKConfig } from "@/server/bare/registry/config-registry";
import { setRuntimeContext } from "@/server/bare/registry/runtime-context-registry";
import { type ServerProfiler } from "./profiling";
import { nowMs } from "@/profiling/clock";

function getProfilingMetaFromRequest(
  request: Request,
): ProfilingRequestMeta | undefined {
  if (PROFILING_KEY in request) {
    return (request as Record<string, unknown>)[
      PROFILING_KEY
    ] as ProfilingRequestMeta;
  }
  return undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type ReplyHandler = (
  request: any,
  ...args: any[]
) => Promise<Response> | Response;
type StreamHandler = (request: any, ...args: any[]) => AsyncGenerator<Response>;
type ProgressHandler = (request: any, ...args: any[]) => Promise<Response>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type HandlerEntry = {
  type: "reply" | "stream";
  handler: ReplyHandler | StreamHandler | ProgressHandler;
  delegatedHandler?: ReplyHandler | StreamHandler | ProgressHandler;
  isDelegated?: (request: Request) => boolean;
  supportsProgress?: boolean | ((request: Request) => boolean);
};

async function executeReplyHandler(
  req: RPC.IncomingRequest,
  request: Request,
  handler: ReplyHandler,
  profiler: ServerProfiler,
  isDelegated: boolean,
) {
  profiler.startHandler();
  try {
    let response: Response;
    if (isDelegated) {
      const profilingMeta = getProfilingMetaFromRequest(request);
      response = await handler(
        request,
        profilingMeta ? { profilingMeta } : undefined,
      );
    } else {
      response = await handler(request);
    }
    profiler.endHandler();
    req.reply(profiler.serialize(response, true), "utf-8");
  } catch (error) {
    profiler.endHandler();
    sendErrorResponse(req, error, profiler);
  }
}

async function executeStreamHandler(
  req: RPC.IncomingRequest,
  request: Request,
  handler: StreamHandler,
  profiler: ServerProfiler,
  isDelegated: boolean,
) {
  const stream = req.createResponseStream();
  profiler.startHandler();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let generator: AsyncGenerator<Response, any, any>;
    if (isDelegated) {
      const profilingMeta = getProfilingMetaFromRequest(request);
      generator = handler(
        request,
        profilingMeta ? { profilingMeta } : undefined,
      );
    } else {
      generator = handler(request);
    }
    for await (const response of generator) {
      stream.write(profiler.serialize(response, false) + "\n", "utf-8");
    }
    profiler.endHandler();
    const trailer = profiler.serialize();
    if (trailer) {
      stream.write(trailer + "\n", "utf-8");
    }

    stream.end();
  } catch (error) {
    profiler.endHandler();
    sendStreamErrorResponse(stream, error, profiler);
  }
}

const PROGRESS_THROTTLE_MS = 150;

async function executeProgressHandler(
  req: RPC.IncomingRequest,
  request: Request,
  handler: ProgressHandler,
  profiler: ServerProfiler,
  isDelegated: boolean,
) {
  const stream = req.createResponseStream();
  profiler.startHandler();

  let lastProgressWrite = 0;
  let pendingUpdate: Response | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const writeProgress = (update: Response) => {
    stream.write(profiler.serialize(update, false) + "\n", "utf-8");
  };

  const progressCallback = (update: Response) => {
    const now = nowMs();
    if (now - lastProgressWrite >= PROGRESS_THROTTLE_MS) {
      lastProgressWrite = now;
      pendingUpdate = null;
      writeProgress(update);
    } else {
      pendingUpdate = update;
      if (!flushTimer) {
        flushTimer = setTimeout(
          () => {
            flushTimer = null;
            if (pendingUpdate) {
              lastProgressWrite = nowMs();
              writeProgress(pendingUpdate);
              pendingUpdate = null;
            }
          },
          PROGRESS_THROTTLE_MS - (now - lastProgressWrite),
        );
      }
    }
  };

  try {
    let response: Response;
    if (isDelegated) {
      const profilingMeta = getProfilingMetaFromRequest(request);
      const options: {
        progressCallback: typeof progressCallback;
        profilingMeta?: ProfilingRequestMeta;
      } = { progressCallback };
      if (profilingMeta) {
        options.profilingMeta = profilingMeta;
      }
      response = await handler(request, options);
    } else {
      response = await handler(request, progressCallback);
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingUpdate) {
      writeProgress(pendingUpdate);
      pendingUpdate = null;
    }
    profiler.endHandler();
    stream.write(profiler.serialize(response, true) + "\n", "utf-8");
    stream.end();
  } catch (error) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingUpdate) {
      writeProgress(pendingUpdate);
      pendingUpdate = null;
    }
    profiler.endHandler();
    sendStreamErrorResponse(stream, error, profiler);
  }
}

// Unified handler executor with delegation and progress support
export async function executeHandler(
  req: RPC.IncomingRequest,
  request: Request,
  entry: HandlerEntry,
  profiler: ServerProfiler,
) {
  const isDelegated = !!(
    entry.delegatedHandler && entry.isDelegated?.(request)
  );
  const handler = isDelegated ? entry.delegatedHandler! : entry.handler;

  const wantsProgress =
    "withProgress" in request &&
    request.withProgress &&
    (typeof entry.supportsProgress === "function"
      ? entry.supportsProgress(request)
      : entry.supportsProgress);

  if (entry.type === "stream") {
    await executeStreamHandler(
      req,
      request,
      handler as StreamHandler,
      profiler,
      isDelegated,
    );
  } else if (wantsProgress) {
    await executeProgressHandler(
      req,
      request,
      handler as ProgressHandler,
      profiler,
      isDelegated,
    );
  } else {
    await executeReplyHandler(
      req,
      request,
      handler as ReplyHandler,
      profiler,
      isDelegated,
    );
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
