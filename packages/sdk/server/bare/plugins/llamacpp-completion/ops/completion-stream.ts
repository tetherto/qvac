import type { RunOptions } from "@qvac/llm-llamacpp";
import type {
  CompletionParams,
  CompletionStats,
  GenerationParams,
  Tool,
  ToolCall,
} from "@/schemas";
import type { ToolCallEvent } from "@/schemas/tools";
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
import fs, { promises as fsPromises } from "bare-fs";

interface ResponseWithStats {
  stats?: LlmStats;
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

type CompletionRunOptions = Pick<RunOptions, "cacheKey" | "saveCacheToDisk"> & {
  generationParams?: GenerationParams;
};

export function clearCachedMessageCounts(cachePath?: string): void {
  if (cachePath) {
    cachedMessageCounts.delete(cachePath);
  } else {
    cachedMessageCounts.clear();
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

function prepareMessagesForCache(
  cachePathToUse: string,
  cacheExists: boolean,
  history: {
    role: string;
    content: string;
    attachments?: { path: string }[] | undefined;
  }[],
): ChatHistory[] {
  if (cacheExists && history.length > 0) {
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

  const historyWithoutSystem = history.filter((msg) => msg.role !== "system");
  return transformMessages(historyWithoutSystem);
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
  { modelExecutionMs: number; stats?: CompletionStats; toolCalls: ToolCall[] },
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

  let historyWithTools: Array<
    | {
        role: string;
        content: string;
        attachments?: { path: string }[] | undefined;
      }
    | Tool
  > = history;

  if (tools && tools.length > 0 && toolsEnabled) {
    historyWithTools = insertToolsIntoHistory(history, tools);
    setupToolGrammar(modelConfig as Record<string, unknown>, tools);
  }

  const transformedHistory = transformMessages(historyWithTools);
  const model = getModel(modelId);

  if (kvCache) {
    const modelConfig = getModelConfig(modelId);
    const systemPromptFromHistory = extractSystemPrompt(history);
    const configHash = generateConfigHash(systemPromptFromHistory, tools);

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
          tools && toolsEnabled ? tools : undefined,
        );
        markCacheInitialized(modelId, configHash, kvCache);
        cacheExists = true;
      }

      const messagesToSend = prepareMessagesForCache(
        cachePathToUse,
        cacheExists,
        history,
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
          tools && toolsEnabled ? tools : undefined,
        );
        markCacheInitialized(modelId, configHash, currentCacheInfo.cacheKey);
        cacheExists = true;
      }

      const messagesToSend = prepareMessagesForCache(
        cachePathToUse,
        cacheExists,
        history,
      );
      logMessagesToAddon(messagesToSend, "PROMPT_SEND");

      const result = yield* processModelResponse(
        model,
        messagesToSend,
        tools,
        generationParams,
        { cacheKey: cachePathToUse, saveCacheToDisk: true },
      );
      const saveVerified = await recordCacheSaveCount(
        cachePathToUse,
        history.length + 1,
      );

      if (
        saveVerified &&
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
      tools,
      generationParams,
    );
  }
}
