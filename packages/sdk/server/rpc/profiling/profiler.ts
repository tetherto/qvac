import { nowMs } from "@/profiling";
import {
  responseSchema,
  DELEGATION_BREAKDOWN_KEY,
  OPERATION_EVENT_KEY,
  PROFILING_TRAILER_KEY,
  type Response,
  type ProfilingRequestMeta,
  type DelegationBreakdown,
  type OperationEvent,
} from "@/schemas";
import {
  createProfilingContext,
  injectProfilingIntoString,
  type ServerProfilingContext,
} from "./context";

type ResponseWithProfilingMeta = Response & {
  [DELEGATION_BREAKDOWN_KEY]?: DelegationBreakdown;
  [OPERATION_EVENT_KEY]?: OperationEvent;
};

export type ServerProfiler = {
  markRequestParsed: (ms: number) => void;
  markRequestValidated: (ms: number) => void;
  startHandler: () => void;
  endHandler: () => void;
  serialize: (response?: Response, final?: boolean) => string;
  serializeError: (json: string) => string;
  getContext: () => ServerProfilingContext | undefined;
};

const noopProfiler: ServerProfiler = {
  markRequestParsed: () => {},
  markRequestValidated: () => {},
  startHandler: () => {},
  endHandler: () => {},
  serialize: (response) => {
    if (!response) return "";

    const extended = response as ResponseWithProfilingMeta;
    const delegation = extended[DELEGATION_BREAKDOWN_KEY];
    const operation = extended[OPERATION_EVENT_KEY];
    const json = JSON.stringify(responseSchema.parse(response));
    if (delegation || operation) {
      const opts: Parameters<typeof injectProfilingIntoString>[1] = {};
      if (delegation) opts.delegation = delegation;
      if (operation) opts.operation = operation;
      return injectProfilingIntoString(json, opts);
    }
    return json;
  },
  serializeError: (json) => json,
  getContext: () => undefined,
};

function createActiveProfiler(meta: ProfilingRequestMeta): ServerProfiler {
  const ctx = createProfilingContext(meta);
  let handlerStart = 0;
  let handlerEnded = false;
  let cachedDelegation: DelegationBreakdown | undefined;
  let cachedOperation: OperationEvent | undefined;

  return {
    markRequestParsed: (ms) => {
      ctx.jsonParseMs = ms;
    },
    markRequestValidated: (ms) => {
      ctx.zodValidationMs = ms;
    },
    startHandler: () => {
      handlerStart = nowMs();
      handlerEnded = false;
    },
    endHandler: () => {
      if (handlerEnded) return;
      handlerEnded = true;
      ctx.handlerExecutionMs = nowMs() - handlerStart;
    },
    serialize: (response, final = true) => {
      if (!response) {
        const opts: Parameters<typeof injectProfilingIntoString>[1] = { ctx };
        if (cachedDelegation) opts.delegation = cachedDelegation;
        if (cachedOperation) opts.operation = cachedOperation;
        return injectProfilingIntoString(`{"${PROFILING_TRAILER_KEY}":true}`, opts);
      }

      const extended = response as ResponseWithProfilingMeta;
      const delegation = extended[DELEGATION_BREAKDOWN_KEY];
      const operation = extended[OPERATION_EVENT_KEY];

      if (delegation) cachedDelegation = delegation;
      if (operation) cachedOperation = operation;

      const zodStart = nowMs();
      const validated = responseSchema.parse(response);
      ctx.responseZodValidationMs =
        (ctx.responseZodValidationMs ?? 0) + (nowMs() - zodStart);

      const stringifyStart = nowMs();
      const json = JSON.stringify(validated);
      ctx.responseStringifyMs =
        (ctx.responseStringifyMs ?? 0) + (nowMs() - stringifyStart);

      if (final) {
        const opts: Parameters<typeof injectProfilingIntoString>[1] = { ctx };
        if (delegation) opts.delegation = delegation;
        if (operation) opts.operation = operation;
        return injectProfilingIntoString(json, opts);
      }
      return json;
    },
    serializeError: (json) => injectProfilingIntoString(json, { ctx }),
    getContext: () => ctx,
  };
}

export function createServerProfiler(
  meta?: ProfilingRequestMeta,
): ServerProfiler {
  if (
    meta?.includeServer &&
    typeof meta.id === "string" &&
    meta.id.length > 0
  ) {
    return createActiveProfiler(meta);
  }
  return noopProfiler;
}
