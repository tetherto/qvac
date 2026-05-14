import type { AbortSignal } from "bare-abort-controller";
import type { RunOptions } from "@qvac/llm-llamacpp";
import type {
  CompletionParams,
  CompletionStats,
  GenerationParams,
  ResponseFormat,
  Tool,
  ToolCall,
  ToolDialect,
} from "@/schemas";
import { TOOLS_MODE } from "@/schemas/tools";
import {
  logCacheDisabled,
  logCacheInit,
  logCacheSave,
  logMessagesToAddon,
} from "@/server/bare/plugins/llamacpp-completion/ops/cache-logger";
import {
  extractSystemPrompt,
  getCurrentCacheInfo,
} from "@/server/bare/ops/kv-cache-utils";
import {
  getModel,
  getModelConfig,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { decideCachedHistorySlice } from "@/server/bare/plugins/llamacpp-completion/ops/kv-cache-state";
import {
  createKvCacheSession,
  generateConfigHash,
  type KvCacheSession,
  type TurnHandle,
} from "@/server/bare/plugins/llamacpp-completion/ops/kv-cache-session";
import type { DisposableScope } from "@/server/bare/runtime/disposable-scope";
import {
  appendToolsToHistory,
  detectToolDialect,
  prependToolsToHistory,
} from "@/server/utils/tool-integration";
import { parseToolCalls } from "@/server/utils/tools";
import { getResponseFormatJsonSchema } from "@/server/utils/response-format";
import { buildAutoCacheSaveHistory, type CacheMessage } from "@/server/utils";
import { getServerLogger } from "@/logging";
import { AttachmentNotFoundError } from "@/utils/errors-server";
import { nowMs } from "@/profiling";
import {
  buildStreamResult,
  hasDefinedValues,
} from "@/profiling/model-execution";
import type { LlmStats } from "@/server/bare/types/addon-responses";
import fs from "bare-fs";

const logger = getServerLogger();

interface ResponseWithStats {
  stats?: LlmStats;
}

interface CompletionResult {
  modelExecutionMs: number;
  stats?: CompletionStats;
  toolCalls: ToolCall[];
}

interface ProcessModelResponseResult extends CompletionResult {
  responseText: string;
  /**
   * True if the model emitted at least one non-empty text token. Used by
   * `completion()` to decide whether to record a `savedCount` for the
   * kv-cache: a turn that produced nothing (legit early EOS or cancel
   * before any decode) must not leave a `history.length + 1` entry
   * behind, because that count will make the next turn slice its history
   * to an empty payload.
   */
  producedTokens: boolean;
}

interface ChatHistory {
  role?: string;
  content?: string;
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
}

// Internal generation-params shape forwarded to the addon. Extends the
// public `GenerationParams` with `json_schema` (a JSON-Schema string the
// addon will convert to GBNF) so structured-output requests can constrain
// sampling per request without mutating the shared `modelConfig`. The
// addon types in `@qvac/llm-llamacpp@0.17.1`+ already include this field;
// the explicit `&` here keeps typing correct against `^0.16.0` until the
// dep bump propagates and is harmless once it has.
type CompletionGenerationParams = GenerationParams & { json_schema?: string };

type CompletionRunOptions = Pick<
  RunOptions,
  "cacheKey" | "saveCacheToDisk" | "prefill"
> & {
  generationParams?: CompletionGenerationParams;
};

/**
 * Decide whether a completed turn earned the right to record its kv-cache
 * boundary. A `savedCount` is only safe to write when the turn ran to
 * completion AND produced at least one token — anything else (cancelled
 * mid-decode, zero-token reply, early EOS) leaves the on-disk cache file
 * in an unknown state relative to `history.length + 1`, and a stale entry
 * would slice the next turn's history down to an empty payload.
 *
 * Replaces the pre-0.11.0 `shouldRecordSavedCount(wasCancelled, ...)` with
 * a signal-driven check that reads directly from the request's
 * `AbortSignal`. The local helper keeps the call sites in
 * `completion-stream.ts` honest without importing the registry every time.
 */
function shouldCommitTurn(
  signal: AbortSignal,
  producedTokens: boolean,
): boolean {
  return !signal.aborted && producedTokens;
}

function transformMessage(
  message:
    | {
        role: string;
        content: string;
        attachments?: { path: string }[] | undefined;
      }
    | Tool,
): ChatHistory[] {
  const transformed: ChatHistory[] = [];

  // Check if it's a tool definition (has type: "function")
  if ("type" in message && message.type === "function") {
    transformed.push({
      type: "function",
      name: message.name,
      description: message.description,
      parameters: message.parameters,
    });
    return transformed;
  }

  const msg = message as {
    role: string;
    content: string;
    attachments?: { path: string }[] | undefined;
  };

  if (msg.attachments && msg.attachments.length > 0) {
    for (const attachment of msg.attachments) {
      if (!fs.existsSync(attachment.path)) {
        throw new AttachmentNotFoundError(attachment.path);
      }

      transformed.push({
        role: msg.role,
        content: attachment.path,
        type: "media",
      });
    }
  }

  transformed.push({
    role: msg.role,
    content: msg.content,
  });

  return transformed;
}

function runModel(
  model: AnyModel,
  prompt: ChatHistory[],
  opts?: CompletionRunOptions,
) {
  const run = model.run.bind(model) as (
    prompt: ChatHistory[],
    opts?: CompletionRunOptions,
  ) => ReturnType<typeof model.run>;

  return run(prompt, opts);
}

function transformMessages(
  messages: Array<
    | {
        role: string;
        content: string;
        attachments?: { path: string }[] | undefined;
      }
    | Tool
  >,
): ChatHistory[] {
  const transformed: ChatHistory[] = [];
  for (const message of messages) {
    transformed.push(...transformMessage(message));
  }
  return transformed;
}

async function initSystemPromptCache(
  model: AnyModel,
  cachePathToUse: string,
  systemPromptToUse: string,
  cacheKey: string,
  tools?: Tool[],
) {
  const primeMessages: ChatHistory[] = [
    { role: "system", content: systemPromptToUse },
  ];

  let toolCount = 0;
  if (tools && tools.length > 0) {
    const transformedTools = transformMessages(tools);
    primeMessages.push(...transformedTools);
    toolCount = tools.length;
  }

  logCacheInit(cacheKey, systemPromptToUse, toolCount);
  logMessagesToAddon(primeMessages, "CACHE_INIT");

  const primeResponse = await runModel(model, primeMessages, {
    cacheKey: cachePathToUse,
    saveCacheToDisk: true,
    prefill: true,
  });

  await primeResponse.await();
}

type HistoryMsg = {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
};

/**
 * Pick the messages that need to reach the model for the next turn.
 *
 * Static mode (no `tools` argument):
 *   - Cache miss: send the whole history minus the system message (which
 *     was primed during cache init).
 *   - Cache hit with a recorded `savedCount`: send only the unsaved tail
 *     (`history.slice(savedCount)`), so a multi-message turn (e.g. a
 *     consumer pushing both an assistant transcript and a follow-up user
 *     message between completions) all reaches the model.
 *   - Cache hit with a stale/missing `savedCount`: fall back to the full
 *     non-system history. The session is told (`dropStaleSavedCount`) so
 *     the bad boundary doesn't propagate into the next turn.
 *
 * Dynamic mode (`tools` argument set):
 *   - The addon anchors the tool block after the last user message and
 *     trims tools + the assistant's tool-call output from the cache once
 *     the chain resolves. After that trim, the cache only holds messages
 *     up to the last user turn, so the SDK has to ship the right slice
 *     plus the (possibly new) tool set:
 *       * tool-chain continuation (last role is "tool"): send the trailing
 *         consecutive tool messages, no tool block — tools are still
 *         anchored in the cache from the previous round.
 *       * new user turn after a chain (prev role is "assistant"): send
 *         [assistant, user] so the model sees its own final reply before
 *         the new prompt, then re-anchor the tool block.
 *       * otherwise: send just the last message + tool block.
 */
function prepareMessagesForCache(
  session: KvCacheSession,
  turn: TurnHandle,
  cacheExists: boolean,
  history: HistoryMsg[],
  tools?: Tool[],
): ChatHistory[] {
  const addTools = tools?.length ? transformMessages(tools) : [];
  const dynamic = addTools.length > 0;

  if (!(cacheExists && history.length > 0)) {
    const historyWithoutSystem = history.filter((msg) => msg.role !== "system");
    return [...transformMessages(historyWithoutSystem), ...addTools];
  }

  if (!dynamic) {
    // Static path — slice from the turn's `savedCount` so callers can
    // stage multiple messages between completions. `decideCachedHistorySlice`
    // also guards against the QVAC-17780 stale-count regression: if the
    // saved boundary would slice the history down to an empty payload
    // (e.g. after a cancelled mid-decode), it falls back to the full
    // non-system history and signals the caller to drop the bad entry.
    // The session owns the entry; `dropStaleSavedCount` clears it
    // without touching the on-disk file (the file is still trustworthy
    // — only the boundary count is wrong).
    const { messages, clearStaleCount } = decideCachedHistorySlice(
      turn.savedCount,
      cacheExists,
      history,
    );

    if (clearStaleCount) {
      session.dropStaleSavedCount(turn);
    }

    return transformMessages(messages);
  }

  // Dynamic path. The addon trimmed tools after the previous round, so the
  // cache no longer holds the saved-count we'd rely on for slicing — pick
  // the right fragment based on the role of the last history message.
  const lastMsg = history[history.length - 1]!;

  if (lastMsg.role === "tool") {
    const trailingTools: HistoryMsg[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]!;
      if (msg.role !== "tool") break;
      trailingTools.unshift(msg);
    }
    return transformMessages(trailingTools);
  }

  if (lastMsg.role === "user") {
    const prevMsg = history[history.length - 2];
    const tail = prevMsg?.role === "assistant" ? [prevMsg, lastMsg] : [lastMsg];
    return [...transformMessages(tail), ...addTools];
  }

  return [...transformMessages([lastMsg]), ...addTools];
}

type CacheRunOptions = Pick<RunOptions, "cacheKey" | "saveCacheToDisk">;

async function* processModelResponse(
  model: AnyModel,
  messagesToSend: ChatHistory[],
  tools?: Tool[],
  generationParams?: CompletionGenerationParams,
  cacheOptions?: CacheRunOptions,
  dialect?: ToolDialect,
): AsyncGenerator<{ token: string }, ProcessModelResponseResult, unknown> {
  const runOptions: CacheRunOptions & {
    generationParams?: CompletionGenerationParams;
  } = {
    ...(generationParams && { generationParams }),
    ...(cacheOptions?.cacheKey !== undefined && {
      cacheKey: cacheOptions.cacheKey,
    }),
    ...(cacheOptions?.saveCacheToDisk !== undefined && {
      saveCacheToDisk: cacheOptions.saveCacheToDisk,
    }),
  };
  const hasRunOptions = Object.keys(runOptions).length > 0;

  const modelStart = nowMs();
  const response = await runModel(
    model,
    messagesToSend,
    hasRunOptions ? runOptions : undefined,
  );

  let accumulatedText = "";
  let producedTokens = false;
  let toolCallsResult: ToolCall[] = [];

  for await (const token of response.iterate()) {
    const tokenStr = token as string;
    if (tokenStr.length > 0) producedTokens = true;
    accumulatedText += tokenStr;
    yield { token: tokenStr };
  }
  const modelExecutionMs = nowMs() - modelStart;

  if (cacheOptions?.saveCacheToDisk && cacheOptions.cacheKey) {
    logCacheSave(cacheOptions.cacheKey);
  }

  if (tools && tools.length > 0) {
    const { toolCalls } = parseToolCalls(accumulatedText, tools, dialect);
    toolCallsResult = toolCalls;
  }

  const responseWithStats = response as unknown as ResponseWithStats;
  const stats: CompletionStats = {
    ...(responseWithStats.stats?.TTFT !== undefined && {
      timeToFirstToken: responseWithStats.stats.TTFT,
    }),
    ...(responseWithStats.stats?.TPS !== undefined && {
      tokensPerSecond: responseWithStats.stats.TPS,
    }),
    ...(responseWithStats.stats?.CacheTokens !== undefined && {
      cacheTokens: responseWithStats.stats.CacheTokens,
    }),
    ...(responseWithStats.stats?.generatedTokens !== undefined && {
      generatedTokens: responseWithStats.stats.generatedTokens,
    }),
    ...(responseWithStats.stats?.backendDevice !== undefined && {
      backendDevice: responseWithStats.stats.backendDevice,
    }),
  };

  return {
    ...buildStreamResult(
      modelExecutionMs,
      hasDefinedValues(stats) ? stats : undefined,
    ),
    toolCalls: toolCallsResult,
    responseText: accumulatedText,
    producedTokens,
  };
}

export async function* completion(
  params: CompletionParams & {
    tools?: Tool[];
    generationParams?: GenerationParams;
    toolDialect?: ToolDialect;
    responseFormat?: ResponseFormat;
  },
  opts: { signal: AbortSignal; scope: DisposableScope },
): AsyncGenerator<{ token: string }, CompletionResult, unknown> {
  const { history, modelId, kvCache, tools, generationParams, responseFormat } =
    params;
  const { signal, scope } = opts;

  const modelConfig = getModelConfig(modelId);
  const toolsEnabled = (modelConfig as { tools?: boolean }).tools === true;
  const toolsMode = (modelConfig as { toolsMode?: string }).toolsMode;
  const dynamicTools =
    !!tools?.length && toolsEnabled && toolsMode === TOOLS_MODE.dynamic;
  const staticTools = !!tools?.length && toolsEnabled && !dynamicTools;

  const dialect =
    tools && tools.length > 0
      ? (params.toolDialect ?? detectToolDialect(modelId))
      : undefined;

  // `responseFormat` is forwarded to the addon as a per-request
  // `generationParams.json_schema`, which the addon converts to GBNF and
  // applies for the duration of the request only. This avoids mutating
  // the shared `modelConfig` and is therefore safe under concurrent
  // completions on the same model. `tools` still constrain output through
  // their parameter schema and the dialect-specific parser chain (mutually
  // exclusive with a non-text `responseFormat` at the schema layer).
  let mergedGenerationParams: CompletionGenerationParams | undefined =
    generationParams;
  if (responseFormat && !(tools && tools.length > 0)) {
    const jsonSchema = getResponseFormatJsonSchema(responseFormat);
    if (jsonSchema !== undefined) {
      mergedGenerationParams = {
        ...(generationParams ?? {}),
        json_schema: jsonSchema,
      };
    }
  }

  const model = getModel(modelId);

  // Hard-cancel wiring: when the registry aborts the request's signal,
  // forward to the addon so the C++ work stops as soon as it can. The
  // SDK still treats `signal.aborted` as the truth for cancel detection
  // (post-completion bookkeeping below) — this listener only shortens
  // the latency between "user clicked stop" and "addon stops decoding".
  //
  // Fire-and-forget by construction (event listeners can't `await`), but
  // `addon.cancel()` returns a Promise — if it ever rejects the bare
  // `void` would leak it as an unhandledRejection. Attach `.catch(...)`
  // so a rejection is logged and the process stays clean; the iterator
  // below still sees EOF/empty tokens via the addon's normal cancel path
  // so callers aren't affected.
  const onAbort = () => {
    const addon = model.addon;
    if (addon?.cancel) {
      addon.cancel.call(addon).catch((err: unknown) => {
        logger.warn(
          `[cancel] addon.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // `addEventListener("abort", ..., { once: true })` does *not* fire if
  // the signal is already aborted at register time — but the registry
  // synchronously aborts a fresh controller when `parentSignal` was
  // already aborted at `begin(...)`. Without this fall-through, the
  // addon would keep decoding until the post-loop check notices.
  // Re-using `onAbort` here keeps the listener body as the single
  // source of truth for "what cancel does."
  if (signal.aborted) onAbort();

  // Detach the abort listener on every exit path (happy, throw, generator
  // `return()` from upstream). `{ once: true }` already removes the
  // listener if the signal fires, so the `removeEventListener` here is
  // the cleanup hook for the signal-never-fired path.
  scope.defer(() => {
    signal.removeEventListener("abort", onAbort);
  });

  if (!kvCache) {
    // KV-cache disabled — straight passthrough, no session involvement.
    let historyWithTools: Array<HistoryMsg | Tool> = history;
    if (staticTools && tools) {
      historyWithTools = prependToolsToHistory(history, tools);
    } else if (dynamicTools && tools) {
      historyWithTools = appendToolsToHistory(history, tools);
    }

    const transformedHistory = transformMessages(historyWithTools);
    logCacheDisabled();
    logMessagesToAddon(transformedHistory, "NO_CACHE");
    return yield* processModelResponse(
      model,
      transformedHistory,
      tools,
      mergedGenerationParams,
      undefined,
      dialect,
    );
  }

  // ---- KV-cache path. The session owns all three bookkeeping layers
  // (on-disk `.bin`, `initializedCaches`, `cachedMessageCounts`). The
  // handler asks for a turn, registers rollback on the scope, and on
  // the happy path calls `commitTurn` which short-circuits the deferred
  // rollback. Cancellations / zero-token replies / rename failures all
  // unwind through the same `scope.defer` hook. ----

  const session = createKvCacheSession(modelId);
  const systemPromptFromHistory = extractSystemPrompt(history);
  // Dynamic mode lets each turn carry its own tool set, so the cache
  // hash must not depend on the tool list — otherwise a tool change
  // would force a fresh cache file and defeat the whole optimisation.
  const configHash = generateConfigHash(
    systemPromptFromHistory,
    dynamicTools ? undefined : tools,
  );

  const systemPromptToUse =
    systemPromptFromHistory ||
    (modelConfig as { system_prompt?: string }).system_prompt ||
    "You are a helpful assistant.";

  const primeIfMissing = async (cachePath: string) => {
    await initSystemPromptCache(
      model,
      cachePath,
      systemPromptToUse,
      typeof kvCache === "string" ? kvCache : "auto",
      // Static-mode tools are baked into the system-prompt cache so
      // they're shared across the session. Dynamic-mode tools belong
      // to a per-turn anchor and must not enter the system cache.
      staticTools ? tools : undefined,
    );
  };

  let turn: TurnHandle;
  if (typeof kvCache === "string") {
    turn = await session.beginTurn({
      kind: "custom",
      customKey: kvCache,
      configHash,
      primeIfMissing,
    });
  } else {
    const cacheMessages: CacheMessage[] = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
      attachments: msg.attachments ?? undefined,
    }));
    turn = await session.beginTurn({
      kind: "auto",
      configHash,
      history: cacheMessages,
      primeIfMissing,
    });
  }

  // Single cleanup hook for every non-success exit path. `commitTurn`
  // flips the turn's internal `committed` flag so this becomes a no-op
  // on the happy path. Scope unwinding is LIFO — registered after the
  // `removeEventListener` defer above so rollback runs before the
  // listener detach.
  scope.defer(() => session.rollback(turn));

  // `cacheExists` is implied by `beginTurn` — the session either found
  // an existing cache or just primed one. Pass `true` to the message
  // selector so the slicing branches engage.
  const messagesToSend = prepareMessagesForCache(
    session,
    turn,
    /* cacheExists */ true,
    history,
    dynamicTools ? tools : undefined,
  );
  logMessagesToAddon(messagesToSend, "PROMPT_SEND");

  const result = yield* processModelResponse(
    model,
    messagesToSend,
    tools,
    mergedGenerationParams,
    { cacheKey: turn.cachePath, saveCacheToDisk: true },
    dialect,
  );

  if (typeof kvCache === "string") {
    // Custom-key path: the addon wrote the new cache state inline at
    // the same path. Either commit (records the boundary, suppresses
    // rollback) or fall through to the deferred rollback.
    if (shouldCommitTurn(signal, result.producedTokens)) {
      await session.commitTurn(turn, {
        kind: "static",
        messageCount: history.length + 1,
      });
    }
    return result;
  }

  // Auto-cache path.
  //
  // Tool-call turns: the auto-cache key is derived from
  // `result.responseText`, which here is raw tool-call markup rather
  // than a clean assistant message. There's no safe post-response key
  // to rename to, so we let the deferred rollback drop the file. Once
  // the SDK supports auto-cache for structured assistant/tool turns,
  // this becomes a normal commit path.
  if (result.toolCalls.length > 0) {
    logger.warn(
      `[kv-cache] Auto cache tool-call turn; rolling back to avoid disk leak. path=${turn.cachePath}`,
    );
    return result;
  }

  if (!shouldCommitTurn(signal, result.producedTokens)) {
    // Cancelled or zero-token turn — the addon wrote the file but its
    // contents don't correspond to a clean turn boundary. Let the
    // deferred rollback unlink it.
    return result;
  }

  const savedHistory = buildAutoCacheSaveHistory(
    history.map((msg) => ({
      role: msg.role,
      content: msg.content,
      attachments: msg.attachments ?? undefined,
    })),
    result.responseText,
  );
  const postResponseCacheInfo = await getCurrentCacheInfo(
    modelId,
    configHash,
    savedHistory,
  );

  await session.commitTurn(turn, {
    kind: "autoRename",
    targetCachePath: postResponseCacheInfo.cachePath,
    messageCount: savedHistory.length,
  });

  return result;
}
