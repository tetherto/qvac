import type {
  CompletionParams,
  CompletionStats,
  GenerationParams,
  Tool,
  ToolCall,
} from "@/schemas";
import { type ToolCallEvent, ToolsModeType } from "@/schemas/tools";
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
  type CacheMessage,
} from "@/server/bare/ops/kv-cache-utils";
import {
  getModel,
  getModelConfig,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import {
  checkForToolEvents,
  insertToolsIntoHistory,
  setupToolGrammar,
} from "@/server/utils/tool-integration";
import { parseToolCalls } from "@/server/utils/tool-parser";
import { AttachmentNotFoundError } from "@/utils/errors-server";
import { nowMs } from "@/profiling";
import {
  buildStreamResult,
  hasDefinedValues,
} from "@/profiling/model-execution";
import type { LlmStats } from "@/server/bare/types/addon-responses";
import fs from "bare-fs";

type DebugStats = {
  promptTokens: number;
  generatedTokens: number;
  contextSlides: number;
}

interface ResponseWithStats {
  stats?: LlmStats & DebugStats;
}

interface ChatHistory {
  role?: string;
  content?: string;
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
}

const cachedMessageCounts = new Map<string, number>();

export function clearCachedMessageCounts(cachePath?: string): void {
  if (cachePath) {
    cachedMessageCounts.delete(cachePath);
  } else {
    cachedMessageCounts.clear();
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
    } as ChatHistory);
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
    { role: "session", content: cachePathToUse },
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

  const primeResponse = await model.run(primeMessages);

  primeResponse.once("output", () => {
    void primeResponse.cancel();
  });

  await primeResponse.await();
}

type HistoryMsg = {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
}

/**
 * Dynamic tools (anchored) cache contract:
 *
 * Round 1 (cache miss): send full history + tools.
 *   The addon template anchors tools after the last user message.
 *   After generation, tools stay in cache if model called a tool.
 *
 * Round 2+ (chain continuation, last msg is role "tool"):
 *   Send ONLY the new tool response(s). The assistant message and
 *   tools are already in the KV cache from previous rounds.
 *   Tools are NOT re-sent — the addon preserves them at the anchor.
 *
 * New turn (last msg is role "user"):
 *   Send assistant + user messages + tools. A new anchor is created.
 *
 * The app must keep <think> blocks and raw <tool_call> XML in
 * assistant content during the chain (see agentic-tools.ts for the
 * full contract).
 */
function prepareMessagesForCache(
  cachePathToUse: string,
  cacheExists: boolean,
  history: HistoryMsg[],
  tools?: Tool[],
  toolsMode?: string
): ChatHistory[] {
  const addTools = tools?.length ? transformMessages(tools) : [];
  if (cacheExists && history.length > 0) {
    const savedCount = cachedMessageCounts.get(cachePathToUse) ?? 0;
    if (savedCount > 0 && savedCount <= history.length) {
      cachedMessageCounts.delete(cachePathToUse);
    }

    const lastMsg = history[history.length - 1] as HistoryMsg;
    const isToolChainContinuation = lastMsg.role === 'tool';
    let lastMessages: HistoryMsg[];
    if (isToolChainContinuation) {
      // Collect all consecutive tool responses from the end of history.
      lastMessages = [];
      for (let i = history.length - 1; i >= 0; i--) {
        if ((history[i] as HistoryMsg).role === 'tool') {
          lastMessages.unshift(history[i] as HistoryMsg);
        } else {
          break;
        }
      }
    } else if (toolsMode === ToolsModeType.dynamic) {
      const prevMsg = history[history.length - 2];
      if (prevMsg?.role === 'assistant') {
        lastMessages = [prevMsg, lastMsg];
      } else {
        lastMessages = [lastMsg];
      }
    } else {
      lastMessages = [lastMsg];
    }
    const lastTransformedMessages = transformMessages(lastMessages);
    return [
      { role: "session", content: cachePathToUse },
      ...lastTransformedMessages,
      ...(isToolChainContinuation ? [] : addTools),
    ];
  }

  const historyWithoutSystem = history.filter((msg) => msg.role !== "system");
  const transformedHistoryWithoutSystem =
    transformMessages(historyWithoutSystem);

  return [
    { role: "session", content: cachePathToUse },
    ...transformedHistoryWithoutSystem,
    ...addTools,
  ];
}

async function* processModelResponse(
  model: AnyModel,
  messagesToSend: ChatHistory[],
  shouldSaveCache: boolean,
  tools?: Tool[],
  generationParams?: GenerationParams,
): AsyncGenerator<
  { token: string; toolCallEvent?: ToolCallEvent },
  { modelExecutionMs: number; stats?: CompletionStats; toolCalls: ToolCall[] },
  unknown
> {
  const runFn = model.run.bind(model) as (
    msgs: ChatHistory[],
    opts?: unknown,
  ) => ReturnType<typeof model.run>;
  const runOptions = generationParams ? { generationParams } : undefined;

  const modelStart = nowMs();
  const response = await runFn(messagesToSend, runOptions);

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

  if (tools && tools.length > 0) {
    const { toolCalls } = parseToolCalls(accumulatedText, tools);
    toolCallsResult = toolCalls;
  }

  if (shouldSaveCache) {
    const sessionMsg = messagesToSend.find((m) => m.role === "session");
    if (sessionMsg?.content) {
      logCacheSave(sessionMsg.content);
      const cachePath = sessionMsg.content;
      const saveResp = await model.run([
        { role: "session", content: cachePath },
        { role: "session", content: "save" },
      ]);
      try {
        await saveResp.await();
      } catch (err: unknown) {
        logCacheSaveError(cachePath, err);
      }
    }
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
    ...(responseWithStats.stats?.backendDevice !== undefined && {
      backendDevice: responseWithStats.stats.backendDevice,
    }),
    promptTokens: responseWithStats.stats?.promptTokens ?? 0,
    generatedTokens: responseWithStats.stats?.generatedTokens ?? 0,
    contextSlides: responseWithStats.stats?.contextSlides ?? 0,
  } as CompletionStats;

  return {
    ...buildStreamResult(
      modelExecutionMs,
      hasDefinedValues(stats) ? stats : undefined,
    ),
    toolCalls: toolCallsResult,
  };
}

export async function* completion(
  params: CompletionParams & {
    tools?: Tool[];
    generationParams?: GenerationParams;
  },
): AsyncGenerator<
  { token: string; toolCallEvent?: ToolCallEvent },
  { modelExecutionMs: number; stats?: CompletionStats; toolCalls: ToolCall[] },
  unknown
> {
  const { history, modelId, kvCache, tools, generationParams } = params;

  const modelConfig = getModelConfig(modelId);
  const toolsEnabled = (modelConfig as { tools?: boolean }).tools === true;
  const toolsMode = (modelConfig as { toolsMode?: string }).toolsMode;

  let historyWithTools: Array<
    | {
        role: string;
        content: string;
        attachments?: { path: string }[] | undefined;
      }
    | Tool
  > = history;

  if (tools && tools.length > 0 && toolsEnabled) {
    historyWithTools = insertToolsIntoHistory({
      history,
      tools,
      append: toolsMode === ToolsModeType.dynamic,
    });
    setupToolGrammar(modelConfig as Record<string, unknown>, tools);
  }

  const transformedHistory = transformMessages(historyWithTools);
  const model = getModel(modelId);

  if (kvCache) {
    const modelConfig = getModelConfig(modelId);
    const systemPromptFromHistory = extractSystemPrompt(history);
    const toolsModeForHash = (modelConfig as { toolsMode?: string }).toolsMode;
    const systemTools = !!(toolsMode !== ToolsModeType.dynamic && tools?.length && toolsEnabled);
    const dynamicTools = !!(toolsMode === ToolsModeType.dynamic && tools?.length && toolsEnabled);
    const configHash = generateConfigHash(
      systemPromptFromHistory,
      toolsModeForHash !== ToolsModeType.dynamic ? tools : undefined,
    );

    const systemPromptToUse =
      systemPromptFromHistory ||
      (modelConfig as { system_prompt?: string }).system_prompt ||
      "You are a helpful assistant.";

    let cachePathToUse: string;

    if (typeof kvCache === "string") {
      cachePathToUse = await getCacheFilePath(modelId, configHash, kvCache);
      const cacheExists = await customCacheExists(modelId, configHash, kvCache);
      logCacheStatus(kvCache, cacheExists);

      if (!cacheExists) {
        await initSystemPromptCache(
          model,
          cachePathToUse,
          systemPromptToUse,
          kvCache,
          systemTools ? tools : undefined,
        );
        markCacheInitialized(modelId, configHash, kvCache);
      }

      const messagesToSend = prepareMessagesForCache(
        cachePathToUse,
        cacheExists,
        history,
        dynamicTools ? tools : undefined,
        toolsMode,
      );
      logMessagesToAddon(messagesToSend, "PROMPT_SEND");

      const result = yield* processModelResponse(
        model,
        messagesToSend,
        false, // TODO - remove that option?
        tools,
        generationParams,
      );
      cachedMessageCounts.set(cachePathToUse, history.length + 1);
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
      const currentCacheInfo = await getCurrentCacheInfo(
        modelId,
        configHash,
        cacheMessages,
      );

      cachePathToUse =
        existingCache !== null
          ? existingCache.cachePath
          : currentCacheInfo.cachePath;

      let cacheExists = existingCache !== null;
      logCacheStatus("auto", cacheExists);

      if (!cacheExists) {
        await initSystemPromptCache(
          model,
          cachePathToUse,
          systemPromptToUse,
          "auto",
          systemTools ? tools : undefined,
        );
        markCacheInitialized(modelId, configHash, currentCacheInfo.cacheKey);
        cacheExists = true;
      }

      const messagesToSend = prepareMessagesForCache(
        cachePathToUse,
        cacheExists,
        history,
        dynamicTools ? tools : undefined,
        toolsMode,
      );
      logMessagesToAddon(messagesToSend, "PROMPT_SEND");

      const result = yield* processModelResponse(
        model,
        messagesToSend,
        false,
        tools,
        generationParams,
      );
      cachedMessageCounts.set(cachePathToUse, history.length + 1);

      if (
        existingCache !== null &&
        existingCache.cachePath !== currentCacheInfo.cachePath
      ) {
        cachedMessageCounts.delete(existingCache.cachePath);
        cachedMessageCounts.set(currentCacheInfo.cachePath, history.length + 1);
        await renameCacheFile(
          existingCache.cachePath,
          currentCacheInfo.cachePath,
        );
      }

      return result;
    }
  } else {
    logCacheDisabled();
    logMessagesToAddon(transformedHistory, "NO_CACHE");
    return yield* processModelResponse(
      model,
      transformedHistory,
      false,
      tools,
      generationParams,
    );
  }
}
