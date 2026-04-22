import { stream as streamRpc } from "@/client/rpc/rpc-client";
import { getClientLogger } from "@/logging";
import {
  completionStreamResponseSchema,
  type CompletionClientParams,
  type CompletionEvent,
  type CompletionFinal,
  type CompletionRun,
  type CompletionStats,
  type CompletionStreamRequest,
  type McpClientInput,
  type Tool,
  type ToolCallEvent,
  type ToolCallWithCall,
  type RPCOptions,
} from "@/schemas";
import { CompletionFailedError } from "@/utils/errors-server";
import { getMcpToolsWithHandlers } from "@/utils/mcp-adapter";
import {
  validateTools,
  type ToolHandlerMap,
  type ToolInput,
} from "@/utils/tool-helpers";
import { buildFinalFromEvents } from "@/utils/aggregate-events";

const logger = getClientLogger();

type CompletionParams = Omit<CompletionClientParams, "tools"> & {
  tools?: Tool[] | ToolInput[];
  mcp?: McpClientInput[];
  rpcOptions?: RPCOptions;
  captureThinking?: boolean;
  emitRawDeltas?: boolean;
};

/**
 * Generates completion from a language model based on conversation history.
 *
 * Returns a `CompletionRun` whose canonical surfaces are:
 *
 *  - `events`  — `AsyncIterable<CompletionEvent>` of ordered, typed events.
 *  - `final`   — `Promise<CompletionFinal>` with aggregated results once the
 *                stream ends (content, thinking, tool calls, stats, raw text).
 *
 * Legacy convenience fields (`tokenStream`, `text`, `toolCallStream`,
 * `toolCalls`, `stats`) are still available but deprecated — they derive
 * from `events` / `final` internally.
 *
 * @param params - The completion parameters
 * @param params.modelId - The identifier of the model to use for completion
 * @param params.history - Array of conversation messages with role, content, and optional attachments
 * @param params.stream - Whether to stream tokens (true) or return complete response (false). Defaults to true
 * @param params.tools - Optional array of tools (can be simple ToolInput with Zod schemas or full Tool objects)
 * @param params.mcp - Optional array of MCP client inputs for tool integration
 * @param params.captureThinking - Best-effort parsing of `<think>` blocks into `thinkingDelta` events; `final.raw.fullText` always preserves the original output
 * @param params.emitRawDeltas - When true, every raw model token is also emitted as a `rawDelta` event
 * @param params.kvCache - Optional KV cache configuration. Cache files are organized hierarchically:
 *   - Structure: `{kvCacheKey}/{modelId}/{configHash}.bin`
 *   - The configHash includes model config + system prompt to ensure cache isolation
 *   - `true`: Auto-generate cache key based on conversation history
 *   - `"custom-key"`: Use provided string as cache key for manual session management
 *   - `false` or `undefined`: No caching
 *   - ⚡ Performance: When cache exists, only the last message is sent to the model (includes multimodal attachments)
 *   - 🗑️ Cleanup: Use `deleteCache({ kvCacheKey })` to remove cached sessions
 * @returns A CompletionRun — consume via `events` / `final`.
 * @example
 * ```typescript
 * import { z } from "zod";
 *
 * const run = completion({
 *   modelId: "llama-2",
 *   history: [
 *     { role: "user", content: "What's the weather in Tokyo?" }
 *   ],
 *   stream: true,
 *   captureThinking: true,
 *   tools: [{
 *     name: "get_weather",
 *     description: "Get current weather",
 *     parameters: z.object({
 *       city: z.string().describe("City name"),
 *     }),
 *     handler: async (args) => {
 *       return { temperature: 22, condition: "sunny" };
 *     }
 *   }]
 * });
 *
 * for await (const event of run.events) {
 *   if (event.type === "contentDelta") process.stdout.write(event.text);
 *   if (event.type === "toolCall") console.log(event.call.name, event.call.arguments);
 * }
 *
 * const result = await run.final;
 * for (const toolCall of await result.toolCalls) {
 *   if (toolCall.invoke) {
 *     const toolResult = await toolCall.invoke();
 *     console.log(toolResult);
 *   }
 * }
 * ```
 */
export function completion(params: CompletionParams): CompletionRun {
  let statsResolver: (value: CompletionStats | undefined) => void = () => {};
  let statsRejecter: (error: unknown) => void = () => {};
  const statsPromise = new Promise<CompletionStats | undefined>(
    (resolve, reject) => {
      statsResolver = resolve;
      statsRejecter = reject;
    },
  );

  statsPromise.catch(() => {});

  let toolCallsResolver: (value: ToolCallWithCall[]) => void = () => {};
  let toolCallsRejecter: (error: unknown) => void = () => {};
  const toolCallsPromise = new Promise<ToolCallWithCall[]>(
    (resolve, reject) => {
      toolCallsResolver = resolve;
      toolCallsRejecter = reject;
    },
  );

  toolCallsPromise.catch(() => {});

  let finalResolver: (value: CompletionFinal) => void = () => {};
  let finalRejecter: (error: unknown) => void = () => {};
  const finalPromise = new Promise<CompletionFinal>((resolve, reject) => {
    finalResolver = resolve;
    finalRejecter = reject;
  });

  finalPromise.catch(() => {});

  const tokenQueue: string[] = [];
  const toolEventQueue: ToolCallEvent[] = [];
  const eventQueue: CompletionEvent[] = [];
  let done = false;
  let tokenResolve: (() => void) | null = null;
  let toolResolve: (() => void) | null = null;
  let eventResolve: (() => void) | null = null;
  let streamError: Error | null = null;

  const allEvents: CompletionEvent[] = [];

  function notifyWaiters() {
    if (tokenResolve) {
      tokenResolve();
      tokenResolve = null;
    }
    if (toolResolve) {
      toolResolve();
      toolResolve = null;
    }
    if (eventResolve) {
      eventResolve();
      eventResolve = null;
    }
  }

  const processResponses = async () => {
    try {
      let allTools: Tool[] = [];
      const allHandlers: ToolHandlerMap = new Map();

      if (params.tools) {
        const { tools, handlers } = validateTools(params.tools);
        allTools = tools;
        for (const [name, handler] of handlers) {
          if (allHandlers.has(name)) {
            logger.warn(`Duplicate tool handler for "${name}", overwriting`);
          }
          allHandlers.set(name, handler);
        }
      }

      if (params.mcp && params.mcp.length > 0) {
        const { tools: mcpTools, handlers: mcpHandlers } =
          await getMcpToolsWithHandlers(params.mcp);
        allTools = [...mcpTools, ...allTools];
        for (const [name, handler] of mcpHandlers) {
          if (allHandlers.has(name)) {
            logger.warn(`Duplicate tool handler for "${name}", overwriting`);
          }
          allHandlers.set(name, handler);
        }
      }

      const request: CompletionStreamRequest = {
        type: "completionStream",
        modelId: params.modelId,
        history: params.history,
        kvCache: params.kvCache,
        tools: allTools.length > 0 ? allTools : undefined,
        stream: params.stream ?? true,
        generationParams: params.generationParams,
        captureThinking: params.captureThinking,
        emitRawDeltas: params.emitRawDeltas,
      };

      const responses: AsyncGenerator<unknown> = streamRpc(
        request,
        params.rpcOptions,
      );

      for await (const response of responses) {
        if (
          response &&
          typeof response === "object" &&
          "type" in response &&
          response.type === "completionStream"
        ) {
          const streamResponse = completionStreamResponseSchema.parse(response);

          for (const event of streamResponse.events) {
            allEvents.push(event);
            eventQueue.push(event);

            if (event.type === "contentDelta") {
              tokenQueue.push(event.text);
            } else if (event.type === "toolCall") {
              toolEventQueue.push(event);
            }
          }

          notifyWaiters();

          if (streamResponse.done) {
            const { final, error } = buildFinalFromEvents(allEvents, allHandlers);
            if (error) {
              const err = new CompletionFailedError(error.message, error);
              finalRejecter(err);
              statsRejecter(err);
              toolCallsRejecter(err);
            } else {
              finalResolver(final);
              statsResolver(final.stats);
              toolCallsResolver(final.toolCalls);
            }
            done = true;
            notifyWaiters();
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
      statsRejecter(error);
      toolCallsRejecter(error);
      finalRejecter(error);
      done = true;
      notifyWaiters();
    }
  };

  void processResponses();

  const textPromise = (async () => {
    const final = await finalPromise;
    return final.contentText;
  })();

  textPromise.catch(() => {});

  const eventStream = (async function* () {
    while (true) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else if (done) {
        if (streamError !== null) {
          throw streamError as Error;
        }
        break;
      } else {
        await new Promise<void>((resolve) => {
          eventResolve = resolve;
        });
      }
    }
  })();

  if (params.stream) {
    const tokenStream = (async function* () {
      while (true) {
        if (tokenQueue.length > 0) {
          yield tokenQueue.shift()!;
        } else if (done) {
          if (streamError !== null) {
            throw streamError as Error;
          }
          break;
        } else {
          await new Promise<void>((resolve) => {
            tokenResolve = resolve;
          });
        }
      }
    })();

    const toolCallStream = (async function* () {
      while (true) {
        if (toolEventQueue.length > 0) {
          yield toolEventQueue.shift()!;
        } else if (done) {
          if (streamError !== null) {
            throw streamError as Error;
          }
          break;
        } else {
          await new Promise<void>((resolve) => {
            toolResolve = resolve;
          });
        }
      }
    })();

    return {
      events: eventStream,
      final: finalPromise,
      tokenStream,
      toolCallStream,
      text: textPromise,
      stats: statsPromise,
      toolCalls: toolCallsPromise,
    };
  } else {
    const tokenStream = (async function* () {
      //Empty generator for non-streaming mode
    })();

    const toolCallStream = (async function* () {
      //Empty generator for non-streaming mode
    })() as AsyncGenerator<ToolCallEvent>;

    return {
      events: eventStream,
      final: finalPromise,
      tokenStream,
      toolCallStream,
      text: textPromise,
      stats: statsPromise,
      toolCalls: toolCallsPromise,
    };
  }
}
