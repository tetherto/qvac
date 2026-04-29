import type { RunOptions } from "@qvac/llm-llamacpp";
import type {
  CompletionParams,
  CompletionStats,
  GenerationParams,
  Tool,
  ToolCall,
} from "@/schemas";
import { type ToolCallEvent, TOOLS_MODE } from "@/schemas/tools";
import {
  logCacheDisabled,
  logCacheInit,
  logCacheSave,
  logCacheSaveError,
  logCacheStatus,
  logMessagesToAddon,
} from "@/server/bare/plugins/llamacpp-completion/ops/cache-logger";
import {
  customCacheExists,
  extractSystemPrompt,
  findMatchingCache,
  generateConfigHash,
  getCacheFilePath,
  getCurrentCacheInfo,
  markCacheInitialized,
  renameCacheFile,
} from "@/server/bare/ops/kv-cache-utils";
import {
  getModel,
  getModelConfig,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import {
  appendToolsToHistory,
  checkForToolEvents,
  prependToolsToHistory,
  setupToolGrammar,
} from "@/server/utils/tool-integration";
import { parseToolCalls } from "@/server/utils/tool-parser";
import { buildAutoCacheSaveHistory, type CacheMessage } from "@/server/utils";
import { getServerLogger } from "@/logging";
import { AttachmentNotFoundError } from "@/utils/errors-server";
import { nowMs } from "@/profiling";
import {
  buildStreamResult,
  hasDefinedValues,
} from "@/profiling/model-execution";
import type { LlmStats } from "@/server/bare/types/addon-responses";
import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";

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
}

interface ChatHistory {
  role?: string;
  content?: string;
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Tracks, per kv-cache file path, how many history messages have already
 * been committed to that cache. The next static-mode turn reads this to
 * send only the unsaved tail (`history.slice(savedCount)`), which lets a
 * consumer push multiple messages between completions (e.g. an
 * `[assistant, user]` recovery sequence) without resending the whole
 * history.
 *
 * Lifecycle:
 *   - `recordCacheSaveCount` writes here after each completion that
 *     confirmed the addon persisted the cache file.
 *   - `prepareMessagesForCache` reads it on the static path; if the
 *     count is stale (greater than the current history length, i.e. the
 *     consumer rewound their history), the entry is dropped and the
 *     full non-system history is sent instead.
 *   - `clearCachedMessageCounts` invalidates entries when their cache
 *     file is deleted or moved.
 *
 * Dynamic-mode turns do not consume this map — the addon trims tools
 * and the chain output from the kv-cache after each round, so
 * `prepareMessagesForCache` falls back to role-based dispatch (see the
 * jsdoc on that function). Writes still happen on dynamic-mode turns:
 * the recorded count reflects the messages the SDK shipped, not the
 * (possibly trimmed) on-disk cache shape. The map is internally
 * consistent within a single mode.
 *
 * A `kvCache` key should not be reused across modes — the on-disk
 * cache file's layout differs (anchored-and-trimmed in dynamic mode
 * vs. linear in static mode), and the recorded count written by one
 * mode would mis-slice on the next turn under the other. Callers
 * should use a fresh `kvCache` key whenever they switch modes.
 */
const cachedMessageCounts = new Map<string, number>();

type CompletionRunOptions = Pick<RunOptions, "cacheKey" | "saveCacheToDisk"> & {
  generationParams?: GenerationParams;
};

export function clearCachedMessageCounts(prefix?: string): void {
  if (!prefix) {
    cachedMessageCounts.clear();
    return;
  }
  for (const key of cachedMessageCounts.keys()) {
    if (key === prefix) {
      cachedMessageCounts.delete(key);
      continue;
    }
    if (!key.startsWith(prefix + path.sep)) continue;
    cachedMessageCounts.delete(key);
  }
}

// Verify the addon actually persisted the cache file before recording its
// message count. The addon currently swallows write errors silently, so a
// missing file means the next turn must resend the full history rather than
// slicing against a stale `savedCount`.
//
// TODO: once the addon surfaces save failures (e.g. throws
// `UnableToSaveSessionFile` when `llama_state_save_file` returns false),
// drop the `access()` probe and wrap the `model.run()` call in a real
// try/catch that forwards the error to `logCacheSaveError`.
async function recordCacheSaveCount(
  cachePath: string,
  messageCount: number,
): Promise<boolean> {
  try {
    await fsPromises.access(cachePath);
    cachedMessageCounts.set(cachePath, messageCount);
    return true;
  } catch (err) {
    cachedMessageCounts.delete(cachePath);
    logCacheSaveError(cachePath, err);
    return false;
  }
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
  });

  primeResponse.once("output", () => {
    void primeResponse.cancel();
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
 *     non-system history.
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
  cachePathToUse: string,
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
    // Static path — keep the slice-from-savedCount semantics so callers
    // can stage multiple messages between completions.
    const savedCount = cachedMessageCounts.get(cachePathToUse) ?? 0;
    const canSlice = savedCount > 0 && savedCount <= history.length;
    const newMessages = canSlice
      ? history.slice(savedCount)
      : history.filter((msg) => msg.role !== "system");

    if (!canSlice && savedCount > 0) {
      cachedMessageCounts.delete(cachePathToUse);
    }

    return transformMessages(newMessages);
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
    const tail =
      prevMsg?.role === "assistant" ? [prevMsg, lastMsg] : [lastMsg];
    return [...transformMessages(tail), ...addTools];
  }

  return [...transformMessages([lastMsg]), ...addTools];
}

type CacheRunOptions = Pick<RunOptions, "cacheKey" | "saveCacheToDisk">;

async function* processModelResponse(
  model: AnyModel,
  messagesToSend: ChatHistory[],
  tools?: Tool[],
  generationParams?: GenerationParams,
  cacheOptions?: CacheRunOptions,
): AsyncGenerator<
  { token: string; toolCallEvent?: ToolCallEvent },
  ProcessModelResponseResult,
  unknown
> {
  const runOptions: CacheRunOptions & { generationParams?: GenerationParams } =
    {
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
  const emittedToolCallPositions = new Set<number>();
  let toolCallsResult: ToolCall[] = [];

  for await (const token of response.iterate()) {
    const tokenStr = token as string;
    accumulatedText += tokenStr;

    yield { token: tokenStr };

    if (tools && tools.length > 0) {
      const toolEvents = checkForToolEvents(
        accumulatedText,
        tokenStr,
        tools,
        emittedToolCallPositions,
      );

      for (const toolEvent of toolEvents) {
        yield { token: "", toolCallEvent: toolEvent };
      }
    }
  }
  const modelExecutionMs = nowMs() - modelStart;

  if (cacheOptions?.saveCacheToDisk && cacheOptions.cacheKey) {
    logCacheSave(cacheOptions.cacheKey);
  }

  if (tools && tools.length > 0) {
    const { toolCalls } = parseToolCalls(accumulatedText, tools);
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
  };
}

export async function* completion(
  params: CompletionParams & {
    tools?: Tool[];
    generationParams?: GenerationParams;
  },
): AsyncGenerator<
  { token: string; toolCallEvent?: ToolCallEvent },
  CompletionResult,
  unknown
> {
  const { history, modelId, kvCache, tools, generationParams } = params;

  const modelConfig = getModelConfig(modelId);
  const toolsEnabled = (modelConfig as { tools?: boolean }).tools === true;
  const toolsMode = (modelConfig as { toolsMode?: string }).toolsMode;
  const dynamicTools =
    !!tools?.length && toolsEnabled && toolsMode === TOOLS_MODE.dynamic;
  const staticTools =
    !!tools?.length && toolsEnabled && !dynamicTools;

  if (tools && tools.length > 0 && toolsEnabled) {
    setupToolGrammar(modelConfig as Record<string, unknown>, tools);
  }

  const model = getModel(modelId);

  if (kvCache) {
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

    let cachePathToUse: string;

    if (typeof kvCache === "string") {
      cachePathToUse = await getCacheFilePath(modelId, configHash, kvCache);
      let cacheExists = await customCacheExists(modelId, configHash, kvCache);
      logCacheStatus(kvCache, cacheExists);

      if (!cacheExists) {
        await initSystemPromptCache(
          model,
          cachePathToUse,
          systemPromptToUse,
          kvCache,
          // Static-mode tools are baked into the system-prompt cache so
          // they're shared across the session. Dynamic-mode tools belong
          // to a per-turn anchor and must not enter the system cache.
          staticTools ? tools : undefined,
        );
        markCacheInitialized(modelId, configHash, kvCache);
        cacheExists = true;
      }

      const messagesToSend = prepareMessagesForCache(
        cachePathToUse,
        cacheExists,
        history,
        dynamicTools ? tools : undefined,
      );
      logMessagesToAddon(messagesToSend, "PROMPT_SEND");

      const result = yield* processModelResponse(
        model,
        messagesToSend,
        tools,
        generationParams,
        { cacheKey: cachePathToUse, saveCacheToDisk: true },
      );
      await recordCacheSaveCount(cachePathToUse, history.length + 1);
      return result;
    } else {
      // Auto-generate cache key based on conversation history
      const cacheMessages: CacheMessage[] = history.map((msg) => ({
        role: msg.role,
        content: msg.content,
        attachments: msg.attachments ?? undefined,
      }));

      const existingCache = await findMatchingCache(
        modelId,
        configHash,
        cacheMessages,
      );
      const preResponseCacheInfo = await getCurrentCacheInfo(
        modelId,
        configHash,
        cacheMessages,
      );

      cachePathToUse =
        existingCache !== null
          ? existingCache.cachePath
          : preResponseCacheInfo.cachePath;

      let cacheExists = existingCache !== null;
      logCacheStatus("auto", cacheExists);

      if (!cacheExists) {
        await initSystemPromptCache(
          model,
          cachePathToUse,
          systemPromptToUse,
          "auto",
          staticTools ? tools : undefined,
        );
        markCacheInitialized(modelId, configHash, preResponseCacheInfo.cacheKey);
        cacheExists = true;
      }

      const messagesToSend = prepareMessagesForCache(
        cachePathToUse,
        cacheExists,
        history,
        dynamicTools ? tools : undefined,
      );
      logMessagesToAddon(messagesToSend, "PROMPT_SEND");

      const result = yield* processModelResponse(
        model,
        messagesToSend,
        tools,
        generationParams,
        { cacheKey: cachePathToUse, saveCacheToDisk: true },
      );

      // TODO: support auto-cache for tool-call turns by keying off the
      // structured assistant/tool messages callers push into history,
      // not result.responseText (which is raw tool-call markup here).
      // Until then, remove any cache file the addon wrote so it doesn't
      // leak on disk (the next turn would compute a different key and
      // never reach it).
      if (result.toolCalls.length > 0) {
        logger.warn(
          `[kv-cache] Auto cache tool-call turn; removing orphaned cache to avoid disk leak. path=${cachePathToUse}`,
        );
        try {
          await fsPromises.unlink(cachePathToUse);
        } catch (unlinkError) {
          logger.warn(
            `[kv-cache] Failed to remove orphaned tool-turn cache file; disk leak likely. path=${cachePathToUse} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
          );
        }
        cachedMessageCounts.delete(cachePathToUse);
        return result;
      }

      const savedHistory = buildAutoCacheSaveHistory(
        cacheMessages,
        result.responseText,
      );
      const postResponseCacheInfo = await getCurrentCacheInfo(
        modelId,
        configHash,
        savedHistory,
      );

      if (
        !(await renameCacheFile(
          cachePathToUse,
          postResponseCacheInfo.cachePath,
        ))
      ) {
        logger.warn(
          `[kv-cache] Auto cache rename failed; removing stale cache to avoid disk leak. from=${cachePathToUse} to=${postResponseCacheInfo.cachePath}`,
        );
        try {
          await fsPromises.unlink(cachePathToUse);
        } catch (unlinkError) {
          logger.warn(
            `[kv-cache] Failed to remove stale cache file; disk leak likely. path=${cachePathToUse} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
          );
        }
        cachedMessageCounts.delete(cachePathToUse);
        return result;
      }

      cachedMessageCounts.delete(cachePathToUse);
      await recordCacheSaveCount(
        postResponseCacheInfo.cachePath,
        savedHistory.length,
      );

      return result;
    }
  } else {
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
      generationParams,
    );
  }
}
