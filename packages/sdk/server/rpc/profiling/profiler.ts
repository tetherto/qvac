import { nowMs } from "@/profiling";
import {
  responseSchema,
  DELEGATION_BREAKDOWN_KEY,
  type Response,
  type ProfilingRequestMeta,
} from "@/schemas";
import {
  createProfilingContext,
  injectProfilingIntoString,
  type ServerProfilingContext,
} from "./context";
import type { ResponseWithDelegation } from "../delegate-transport";

export type ServerProfiler = {
  markRequestParsed: (ms: number) => void;
  markRequestValidated: (ms: number) => void;
  startHandler: () => void;
  endHandler: () => void;
  serialize: (response: Response, final?: boolean) => string;
  serializeError: (json: string) => string;
  getContext: () => ServerProfilingContext | undefined;
};

const noopProfiler: ServerProfiler = {
  markRequestParsed: () => {},
  markRequestValidated: () => {},
  startHandler: () => {},
  endHandler: () => {},
  serialize: (response) => {
    const delegation = (response as ResponseWithDelegation)[
      DELEGATION_BREAKDOWN_KEY
    ];
    const json = JSON.stringify(responseSchema.parse(response));
    if (delegation) {
      return injectProfilingIntoString(json, { delegation });
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
      const delegation = (response as ResponseWithDelegation)[
        DELEGATION_BREAKDOWN_KEY
      ];

      const zodStart = nowMs();
      const validated = responseSchema.parse(response);
      ctx.responseZodValidationMs =
        (ctx.responseZodValidationMs ?? 0) + (nowMs() - zodStart);

      const stringifyStart = nowMs();
      const json = JSON.stringify(validated);
      ctx.responseStringifyMs =
        (ctx.responseStringifyMs ?? 0) + (nowMs() - stringifyStart);

      const injectionOpts = delegation ? { ctx, delegation } : { ctx };
      return final ? injectProfilingIntoString(json, injectionOpts) : json;
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
