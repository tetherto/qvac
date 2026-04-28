import type RPC from "bare-rpc";
import {
  requestSchema,
  responseSchema,
  PROFILING_TRAILER_KEY,
  type Request,
  type Response,
  type RPCOptions,
} from "@/schemas";
import { RPCError } from "./rpc-error";
import { withTimeout, withTimeoutStream } from "@/utils/withTimeout";
import { getClientLogger, summarizeRequest } from "@/logging";
import { getRPC, close as closeRPC, createDuplexSession } from "#rpc";
import {
  nowMs,
  shouldProfile,
  shouldIncludeServerBreakdown,
  generateId as createProfileId,
  createProfilingMeta,
  createProfilingDisabledMeta,
  injectProfilingMetaIntoObject,
  extractProfilingMeta,
  stripProfilingMeta,
  recordFailure,
} from "@/profiling";
import {
  createClientTimings,
  createClientStreamTimings,
  recordClientEvents,
  recordClientStreamEvents,
  cacheConnectionTime,
  flushConnectionTime,
  resetConnectionTracking,
} from "./profiling";

const logger = getClientLogger();

let rpcInstance: Promise<RPC> | null = null;
let commandCounter = 0;
let firstConnectionPending = true;

function getNextCommandId() {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER;
  return commandCounter;
}

function checkAndThrowError(response: Response): void {
  if (response.type === "error") {
    throw new RPCError(response);
  }
}

interface RPCResult {
  rpc: RPC;
  connectionMs?: number;
}

async function getRPCInstance(): Promise<RPCResult> {
  if (rpcInstance) return { rpc: await rpcInstance };

  const connectionStart = firstConnectionPending ? nowMs() : null;
  rpcInstance = getRPC();
  const rpc = await rpcInstance;

  if (connectionStart !== null && firstConnectionPending) {
    firstConnectionPending = false;
    return { rpc, connectionMs: nowMs() - connectionStart };
  }

  return { rpc };
}

interface PreparedRPCContext {
  rpc: RPC;
  profilingEnabled: boolean;
  signalDisable: boolean;
}

async function prepareRPCContext(
  requestType: Request["type"],
  perCallProfiling: RPCOptions["profiling"] | undefined,
  rpc?: RPC,
): Promise<PreparedRPCContext> {
  const rpcResult = rpc ? { rpc } : await getRPCInstance();
  const profilingEnabled = shouldProfile(requestType, perCallProfiling);
  const signalDisable = perCallProfiling?.enabled === false;

  if (rpcResult.connectionMs !== undefined) {
    cacheConnectionTime(rpcResult.connectionMs);
  }
  if (profilingEnabled) {
    flushConnectionTime();
  }

  return { rpc: rpcResult.rpc, profilingEnabled, signalDisable };
}

export async function send<T extends Request>(
  request: T,
  options?: RPCOptions,
  rpc?: RPC,
): Promise<Response> {
  const ctx = await prepareRPCContext(request.type, options?.profiling, rpc);

  if (!ctx.profilingEnabled) {
    return sendBase(request, ctx.rpc, options, ctx.signalDisable);
  }
  return sendProfiled(request, ctx.rpc, options);
}

async function sendBase<T extends Request>(
  request: T,
  rpc: RPC,
  options?: RPCOptions,
  signalDisable: boolean = false,
): Promise<Response> {
  const parsedRequest = requestSchema.parse(request);
  const req = rpc.request(getNextCommandId());
  logger.debug("RPC Client sending:", summarizeRequest(request));
  const payloadObj = signalDisable
    ? injectProfilingMetaIntoObject(
        parsedRequest,
        createProfilingDisabledMeta(),
      )
    : parsedRequest;
  const payload = JSON.stringify(payloadObj);
  req.send(payload, "utf-8");

  const response = await withTimeout(req.reply("utf-8"), options?.timeout);

  const resPayload = responseSchema.parse(
    JSON.parse(response?.toString() || "{}"),
  );
  logger.debug("ResPayload", { type: resPayload.type });

  checkAndThrowError(resPayload);

  return resPayload;
}

async function sendProfiled<T extends Request>(
  request: T,
  rpc: RPC,
  options?: RPCOptions,
): Promise<Response> {
  const requestType = request.type;
  const profileId = createProfileId();
  const includeServer = shouldIncludeServerBreakdown(options?.profiling);
  const timings = createClientTimings(profileId, requestType);

  try {
    const zodStart = nowMs();
    const parsedRequest = requestSchema.parse(request);
    timings.requestZodValidationMs = nowMs() - zodStart;

    const req = rpc.request(getNextCommandId());
    logger.debug("RPC Client sending:", summarizeRequest(request));

    const profilingMeta = createProfilingMeta(profileId, includeServer);
    const requestWithMeta = injectProfilingMetaIntoObject(
      parsedRequest,
      profilingMeta,
    );

    const stringifyStart = nowMs();
    const payload = JSON.stringify(requestWithMeta);
    timings.requestStringifyMs = nowMs() - stringifyStart;

    timings.sendStart = nowMs();
    req.send(payload, "utf-8");

    const response = await withTimeout(req.reply("utf-8"), options?.timeout);
    timings.firstResponseAt = nowMs();

    const parseStart = nowMs();
    const rawParsed = JSON.parse(response?.toString() || "{}") as Record<
      string,
      unknown
    >;
    timings.responseJsonParseMs = nowMs() - parseStart;

    const responseMeta = extractProfilingMeta(rawParsed);
    const cleanPayload = stripProfilingMeta(rawParsed);

    const zodValidateStart = nowMs();
    const resPayload = responseSchema.parse(cleanPayload);
    timings.responseZodValidationMs = nowMs() - zodValidateStart;

    timings.requestEnd = nowMs();

    logger.debug("ResPayload", { type: resPayload.type });

    recordClientEvents(timings, responseMeta);
    checkAndThrowError(resPayload);

    return resPayload;
  } catch (error) {
    if (timings.requestEnd === undefined) {
      const base = {
        ts: nowMs(),
        op: timings.requestType,
        kind: "rpc" as const,
        profileId: timings.profileId,
      };
      recordFailure(base, timings.requestStart, error);
    }
    throw error;
  }
}

export async function* stream<T extends Request>(
  request: T,
  options: RPCOptions = {},
  rpc?: RPC,
): AsyncGenerator<Response> {
  const ctx = await prepareRPCContext(request.type, options?.profiling, rpc);

  if (!ctx.profilingEnabled) {
    yield* streamBase(request, ctx.rpc, options, ctx.signalDisable);
    return;
  }
  yield* streamProfiled(request, ctx.rpc, options);
}

async function* streamBase<T extends Request>(
  request: T,
  rpc: RPC,
  options: RPCOptions = {},
  signalDisable: boolean = false,
): AsyncGenerator<Response> {
  const parsedRequest = requestSchema.parse(request);
  const req = rpc.request(getNextCommandId());
  logger.debug("RPC Client streaming:", summarizeRequest(request));
  const payloadObj = signalDisable
    ? injectProfilingMetaIntoObject(
        parsedRequest,
        createProfilingDisabledMeta(),
      )
    : parsedRequest;
  req.send(JSON.stringify(payloadObj), "utf-8");

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

async function* streamProfiled<T extends Request>(
  request: T,
  rpc: RPC,
  options: RPCOptions = {},
): AsyncGenerator<Response> {
  const requestType = request.type;
  const profileId = createProfileId();
  const includeServer = shouldIncludeServerBreakdown(options?.profiling);
  const timings = createClientStreamTimings(profileId, requestType);
  let profilingMeta: ReturnType<typeof extractProfilingMeta> = undefined;

  try {
    const zodStart = nowMs();
    const parsedRequest = requestSchema.parse(request);
    timings.requestZodValidationMs = nowMs() - zodStart;

    const req = rpc.request(getNextCommandId());
    logger.debug("RPC Client streaming:", summarizeRequest(request));

    const requestMeta = createProfilingMeta(profileId, includeServer);
    const requestWithMeta = injectProfilingMetaIntoObject(
      parsedRequest,
      requestMeta,
    );

    const stringifyStart = nowMs();
    const payload = JSON.stringify(requestWithMeta);
    timings.requestStringifyMs = nowMs() - stringifyStart;

    timings.sendStart = nowMs();
    req.send(payload, "utf-8");

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
      const chunkTime = nowMs();
      if (timings.firstChunkAt === undefined) {
        timings.firstChunkAt = chunkTime;
      }
      timings.lastChunkAt = chunkTime;

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          const rawParsed = JSON.parse(line) as Record<string, unknown>;

          const chunkMeta = extractProfilingMeta(rawParsed);
          if (chunkMeta) {
            profilingMeta = chunkMeta;
          }

          if (rawParsed[PROFILING_TRAILER_KEY] === true) continue;
          const cleanPayload = stripProfilingMeta(rawParsed);
          const response = responseSchema.parse(cleanPayload);

          timings.chunkCount++;
          checkAndThrowError(response);
          yield response;
        }
      }
    }
  } catch (error) {
    if (timings.requestEnd === undefined) {
      const base = {
        ts: nowMs(),
        op: timings.requestType,
        kind: "rpc" as const,
        profileId: timings.profileId,
      };
      recordFailure(base, timings.requestStart, error);
    }
    throw error;
  } finally {
    if (timings.chunkCount > 0) {
      timings.requestEnd = nowMs();
      recordClientStreamEvents(timings, profilingMeta);
    }
  }
}

export interface DuplexWritable {
  write(chunk: Buffer): void;
  end(): void;
  destroy(): void;
}

export interface DuplexReadable extends AsyncIterable<Buffer> {
  destroy(): void;
}

export interface DuplexSession {
  requestStream: DuplexWritable;
  responseStream: DuplexReadable;
}

export async function duplex<T extends Request>(
  request: T,
  options?: RPCOptions,
): Promise<DuplexSession> {
  const ctx = await prepareRPCContext(request.type, options?.profiling);

  if (!ctx.profilingEnabled) {
    return duplexBase(request, ctx.signalDisable, options?.timeout);
  }
  return duplexProfiled(request, options);
}

async function duplexBase<T extends Request>(
  request: T,
  signalDisable: boolean,
  timeout?: number,
): Promise<DuplexSession> {
  const parsedRequest = requestSchema.parse(request);
  logger.debug("RPC Client duplex:", summarizeRequest(request));

  const payloadObj = signalDisable
    ? injectProfilingMetaIntoObject(
        parsedRequest,
        createProfilingDisabledMeta(),
      )
    : parsedRequest;
  const payload = JSON.stringify(payloadObj);
  const sessionPromise = createDuplexSession(payload, getNextCommandId());
  const session = await withTimeout(sessionPromise, timeout);
  return {
    requestStream: session.requestStream,
    responseStream: session.responseStream as DuplexReadable,
  };
}

async function duplexProfiled<T extends Request>(
  request: T,
  options: RPCOptions = {},
): Promise<DuplexSession> {
  const requestType = request.type;
  const profileId = createProfileId();
  const includeServer = shouldIncludeServerBreakdown(options?.profiling);
  const timings = createClientStreamTimings(profileId, requestType);

  let session: Awaited<ReturnType<typeof createDuplexSession>>;

  try {
    const zodStart = nowMs();
    const parsedRequest = requestSchema.parse(request);
    timings.requestZodValidationMs = nowMs() - zodStart;

    logger.debug("RPC Client duplex:", summarizeRequest(request));

    const requestMeta = createProfilingMeta(profileId, includeServer);
    const requestWithMeta = injectProfilingMetaIntoObject(
      parsedRequest,
      requestMeta,
    );

    const stringifyStart = nowMs();
    const payload = JSON.stringify(requestWithMeta);
    timings.requestStringifyMs = nowMs() - stringifyStart;

    timings.sendStart = nowMs();
    const sessionPromise = createDuplexSession(payload, getNextCommandId());
    session = await withTimeout(sessionPromise, options?.timeout);
  } catch (error) {
    const base = {
      ts: nowMs(),
      op: timings.requestType,
      kind: "rpc" as const,
      profileId: timings.profileId,
    };
    recordFailure(base, timings.requestStart, error);
    throw error;
  }

  let profilingMeta: ReturnType<typeof extractProfilingMeta> = undefined;

  const rawReadable = session.responseStream as DuplexReadable;

  async function* profiledResponseStream(): AsyncGenerator<Buffer> {
    let lineBuffer = "";
    try {
      for await (const chunk of rawReadable) {
        const chunkTime = nowMs();
        if (timings.firstChunkAt === undefined) {
          timings.firstChunkAt = chunkTime;
        }
        timings.lastChunkAt = chunkTime;

        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";

        const outputParts: string[] = [];

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            outputParts.push(line);
            continue;
          }

          const chunkMeta = extractProfilingMeta(parsed);
          if (chunkMeta) {
            profilingMeta = chunkMeta;
          }

          if (parsed[PROFILING_TRAILER_KEY] === true) {
            continue;
          }

          // Yield original line — consumer's Zod .parse() strips profiling keys
          outputParts.push(line);
        }

        if (outputParts.length > 0) {
          timings.chunkCount += outputParts.length;
          yield Buffer.from(outputParts.join("\n") + "\n");
        }
      }

      if (lineBuffer.trim()) {
        timings.chunkCount++;
        yield Buffer.from(lineBuffer + "\n");
      }
    } catch (error) {
      if (timings.requestEnd === undefined) {
        const base = {
          ts: nowMs(),
          op: timings.requestType,
          kind: "rpc" as const,
          profileId: timings.profileId,
        };
        recordFailure(base, timings.requestStart, error);
      }
      throw error;
    } finally {
      if (timings.chunkCount > 0) {
        timings.requestEnd = nowMs();
        recordClientStreamEvents(timings, profilingMeta);
      }
    }
  }

  const generator = profiledResponseStream();
  const wrappedResponseStream: DuplexReadable = {
    [Symbol.asyncIterator]() {
      return generator[Symbol.asyncIterator]();
    },
    destroy() {
      rawReadable.destroy();
    },
  };

  return {
    requestStream: session.requestStream,
    responseStream: wrappedResponseStream,
  };
}

export async function close() {
  if (!rpcInstance) return;
  rpcInstance = null;
  firstConnectionPending = true;
  resetConnectionTracking();
  await closeRPC();
}
