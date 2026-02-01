import { stream as streamRpc } from "@/client/rpc/rpc-client";
import { getClientLogger } from "@/logging";
import {
  completionStreamResponseSchema,
  type CompletionClientParams,
  type CompletionStats,
  type CompletionStreamRequest,
  type McpClientInput,
  type Tool,
  type ToolCallEvent,
  type ToolCallWithCall,
} from "@/schemas";
import { getMcpToolsWithHandlers } from "@/utils/mcp-adapter";
import {
  attachHandlersToToolCalls,
  validateTools,
  type ToolHandlerMap,
  type ToolInput,
} from "@/utils/tool-helpers";

const logger = getClientLogger();

type CompletionParams = Omit<CompletionClientParams, "tools"> & {
  tools?: Tool[] | ToolInput[];
  mcp?: McpClientInput[];
};

/**
 * Generates completion from a language model based on conversation history.
 *
 * @param params - The completion parameters
 * @param params.modelId - The identifier of the model to use for completion
 * @param params.history - Array of conversation messages with role, content, and optional attachments
 * @param params.stream - Whether to stream tokens (true) or return complete response (false). Defaults to true
 * @param params.tools - Optional array of tools (can be simple ToolInput with Zod schemas or full Tool objects)
 * @param params.mcp - Optional array of MCP client inputs for tool integration
 * @param params.kvCache - Optional KV cache configuration. Cache files are organized hierarchically:
 *   - Structure: `{kvCacheKey}/{modelId}/{configHash}.bin`
 *   - The configHash includes model config + system prompt to ensure cache isolation
 *   - `true`: Auto-generate cache key based on conversation history
 *   - `"custom-key"`: Use provided string as cache key for manual session management
 *   - `false` or `undefined`: No caching
 *   - ⚡ Performance: When cache exists, only the last message is sent to the model (includes multimodal attachments)
 *   - 🗑️ Cleanup: Use `deleteCache({ kvCacheKey })` to remove cached sessions
 * @returns Object with tokenStream generator, toolCallStream generator, text promise, toolCalls promise (with call() method), and stats promise
 * @example
 * ```typescript
 * import { z } from "zod";
 *
 * const result = completion({
 *   modelId: "llama-2",
 *   history: [
 *     { role: "user", content: "What's the weather in Tokyo?" }
 *   ],
 *   stream: true,
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
 * for await (const token of result.tokenStream) {
 *   process.stdout.write(token);
 * }
 *
 * for (const toolCall of await result.toolCalls) {
 *   if (toolCall.invoke) {
 *     const toolResult = await toolCall.invoke();
 *     console.log(toolResult);
 *   }
 * }
 * ```
 */
export function completion(params: CompletionParams): {
  tokenStream: AsyncGenerator<string>;
  toolCallStream: AsyncGenerator<ToolCallEvent>;
  stats: Promise<CompletionStats | undefined>;
  text: Promise<string>;
  toolCalls: Promise<ToolCallWithCall[]>;
} {
  let stats: CompletionStats | undefined;
  let statsResolver: (value: CompletionStats | undefined) => void = () => {};
  let statsRejecter: (error: unknown) => void = () => {};
  const statsPromise = new Promise<CompletionStats | undefined>(
    (resolve, reject) => {
      statsResolver = resolve;
      statsRejecter = reject;
    },
  );

  statsPromise.catch(() => {});

  let toolCallsArray: ToolCallWithCall[] = [];
  let toolCallsResolver: (value: ToolCallWithCall[]) => void = () => {};
  let toolCallsRejecter: (error: unknown) => void = () => {};
  const toolCallsPromise = new Promise<ToolCallWithCall[]>(
    (resolve, reject) => {
      toolCallsResolver = resolve;
      toolCallsRejecter = reject;
    },
  );

  toolCallsPromise.catch(() => {});

  const tokenQueue: string[] = [];
  const toolEventQueue: ToolCallEvent[] = [];
  let tokenDone = false;
  let toolDone = false;
  let tokenResolve: (() => void) | null = null;
  let toolResolve: (() => void) | null = null;
  let textBuffer = "";
  let streamError: Error | null = null;

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
      };

      const responses: AsyncGenerator<unknown> = streamRpc(request);

      for await (const response of responses) {
        if (
          response &&
          typeof response === "object" &&
          "type" in response &&
          response.type === "completionStream"
        ) {
          const streamResponse = completionStreamResponseSchema.parse(response);

          if (!streamResponse.done) {
            const token = streamResponse.token;
            if (token) {
              textBuffer += token;
              tokenQueue.push(token);
              if (tokenResolve) {
                tokenResolve();
                tokenResolve = null;
              }
            }

            if (streamResponse.toolCallEvent) {
              toolEventQueue.push(streamResponse.toolCallEvent);
              if (toolResolve) {
                toolResolve();
                toolResolve = null;
              }
            }
          } else {
            if (streamResponse.token) {
              textBuffer += streamResponse.token;
            }
            stats = streamResponse.stats;
            statsResolver(stats);

            const rawToolCalls = streamResponse.toolCalls || [];
            toolCallsArray = attachHandlersToToolCalls(
              rawToolCalls,
              allHandlers,
            );
            toolCallsResolver(toolCallsArray);

            tokenDone = true;
            toolDone = true;
            if (tokenResolve) {
              tokenResolve();
              tokenResolve = null;
            }
            if (toolResolve) {
              toolResolve();
              toolResolve = null;
            }
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
      statsRejecter(error);
      toolCallsRejecter(error);
      tokenDone = true;
      toolDone = true;
      if (tokenResolve) {
        tokenResolve();
        tokenResolve = null;
      }
      if (toolResolve) {
        toolResolve();
        toolResolve = null;
      }
    }
  };

  void processResponses();

  const textPromise = (async () => {
    await statsPromise;
    return textBuffer;
  })();

  textPromise.catch(() => {});

  if (params.stream) {
    const tokenStream = (async function* () {
      while (true) {
        if (tokenQueue.length > 0) {
          yield tokenQueue.shift()!;
        } else if (tokenDone) {
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
        } else if (toolDone) {
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
    })();

    return {
      tokenStream,
      toolCallStream,
      text: textPromise,
      stats: statsPromise,
      toolCalls: toolCallsPromise,
    };
  }
}
