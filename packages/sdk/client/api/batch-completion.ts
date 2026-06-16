import { stream as streamRpc } from "@/client/rpc/rpc-client";
import { generateClientRequestId } from "@/client/api/client-request-id";
import {
  batchCompletionStreamResponseSchema,
  type BatchCompletionClientParams,
  type BatchCompletionEvent,
  type BatchCompletionResult,
  type BatchCompletionRun,
  type BatchCompletionStreamRequest,
  type CompletionEvent,
  type CompletionFinal,
  type CompletionStats,
  type RPCOptions,
} from "@/schemas";
import { buildFinalFromEvents } from "@/utils/aggregate-events";
import {
  CompletionFailedError,
  InferenceCancelledError,
} from "@/utils/errors-server";
import type { ToolHandlerMap } from "@/utils/tool-helpers";

type BatchCompletionParams = Omit<
  BatchCompletionClientParams,
  "requestId"
> & {
  rpcOptions?: RPCOptions;
};

type PerIdState = {
  eventQueue: CompletionEvent[];
  allEvents: CompletionEvent[];
  final: Promise<CompletionFinal>;
  finalResolver: (value: CompletionFinal) => void;
  finalRejecter: (error: unknown) => void;
  eventResolve: (() => void) | null;
  done: boolean;
};

function createPerIdState(): PerIdState {
  let finalResolver: (value: CompletionFinal) => void = () => {};
  let finalRejecter: (error: unknown) => void = () => {};
  const final = new Promise<CompletionFinal>((resolve, reject) => {
    finalResolver = resolve;
    finalRejecter = reject;
  });

  final.catch(() => {});

  return {
    eventQueue: [],
    allEvents: [],
    final,
    finalResolver,
    finalRejecter,
    eventResolve: null,
    done: false,
  };
}

export function batchCompletion(
  params: BatchCompletionParams,
): BatchCompletionRun {
  const requestId = generateClientRequestId();
  const states = new Map<string, PerIdState>();
  const eventQueue: BatchCompletionEvent[] = [];
  const allHandlers: ToolHandlerMap = new Map();

  let eventResolve: (() => void) | null = null;
  let idsResolver: (value: string[]) => void = () => {};
  let idsRejecter: (error: unknown) => void = () => {};
  let resultsResolver: (value: BatchCompletionResult[]) => void = () => {};
  let resultsRejecter: (error: unknown) => void = () => {};
  let statsResolver: (value: CompletionStats | undefined) => void = () => {};
  let statsRejecter: (error: unknown) => void = () => {};
  let idsResolved = false;
  let done = false;
  let streamError: Error | null = null;

  const idsPromise = new Promise<string[]>((resolve, reject) => {
    idsResolver = resolve;
    idsRejecter = reject;
  });
  idsPromise.catch(() => {});

  const resultsPromise = new Promise<BatchCompletionResult[]>(
    (resolve, reject) => {
      resultsResolver = resolve;
      resultsRejecter = reject;
    },
  );
  resultsPromise.catch(() => {});

  const statsPromise = new Promise<CompletionStats | undefined>(
    (resolve, reject) => {
      statsResolver = resolve;
      statsRejecter = reject;
    },
  );
  statsPromise.catch(() => {});

  function ensureState(id: string) {
    let state = states.get(id);
    if (!state) {
      state = createPerIdState();
      states.set(id, state);
    }
    return state;
  }

  function notifyWaiters() {
    if (eventResolve) {
      eventResolve();
      eventResolve = null;
    }
    for (const state of states.values()) {
      if (state.eventResolve) {
        state.eventResolve();
        state.eventResolve = null;
      }
    }
  }

  function resolveIds(ids: string[]) {
    if (idsResolved) return;
    idsResolved = true;
    for (const id of ids) ensureState(id);
    idsResolver(ids);
  }

  function rejectAll(error: unknown) {
    idsRejecter(error);
    resultsRejecter(error);
    statsRejecter(error);
    for (const state of states.values()) state.finalRejecter(error);
  }

  function finishAll(ids: string[]) {
    const results: BatchCompletionResult[] = [];
    let firstError: unknown;

    for (const id of ids) {
      const state = ensureState(id);
      const { final, error, cancelled } = buildFinalFromEvents(
        state.allEvents,
        allHandlers,
      );

      if (error) {
        const err = new CompletionFailedError(error.message);
        state.finalRejecter(err);
        firstError ??= err;
      } else if (cancelled) {
        const err = new InferenceCancelledError(requestId, {
          text: final.contentText,
          toolCalls: final.toolCalls,
          ...(final.stats && { stats: final.stats }),
        });
        state.finalRejecter(err);
        firstError ??= err;
      } else {
        state.finalResolver(final);
        results.push({ id, final });
      }

      state.done = true;
    }

    if (firstError !== undefined) {
      resultsRejecter(firstError);
    } else {
      resultsResolver(results);
    }
  }

  const processResponses = async () => {
    try {
      const request: BatchCompletionStreamRequest = {
        type: "batchCompletionStream",
        modelId: params.modelId,
        prompts: params.prompts,
        stream: params.stream ?? true,
        captureThinking: params.captureThinking,
        emitRawDeltas: params.emitRawDeltas,
        toolDialect: params.toolDialect,
        requestId,
      };

      let orderedIds: string[] = [];
      const responses: AsyncGenerator<unknown> = streamRpc(
        request,
        params.rpcOptions,
      );

      for await (const response of responses) {
        if (
          response &&
          typeof response === "object" &&
          "type" in response &&
          response.type === "batchCompletionStream"
        ) {
          const streamResponse =
            batchCompletionStreamResponseSchema.parse(response);

          if (streamResponse.ids) {
            orderedIds = streamResponse.ids;
            resolveIds(orderedIds);
          }

          for (const batchEvent of streamResponse.events) {
            const state = ensureState(batchEvent.id);
            state.allEvents.push(batchEvent.event);
            state.eventQueue.push(batchEvent.event);
            eventQueue.push(batchEvent);
          }

          notifyWaiters();

          if (streamResponse.done) {
            if (!idsResolved) {
              orderedIds =
                orderedIds.length > 0
                  ? orderedIds
                  : params.prompts.map((prompt, index) =>
                      prompt.id ?? String(index),
                    );
              resolveIds(orderedIds);
            }
            statsResolver(streamResponse.stats);
            finishAll(orderedIds);
            done = true;
            notifyWaiters();
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
      rejectAll(error);
      done = true;
      for (const state of states.values()) state.done = true;
      notifyWaiters();
    }
  };

  void processResponses();

  const events = (async function* () {
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

  function byId(id: string) {
    const state = ensureState(id);
    const idEvents = (async function* () {
      while (true) {
        if (state.eventQueue.length > 0) {
          yield state.eventQueue.shift()!;
        } else if (state.done || done) {
          if (streamError !== null) {
            throw streamError;
          }
          break;
        } else {
          await new Promise<void>((resolve) => {
            state.eventResolve = resolve;
          });
        }
      }
    })();

    return {
      events: idEvents,
      final: state.final,
    };
  }

  return {
    requestId,
    ids: idsPromise,
    events,
    results: resultsPromise,
    stats: statsPromise,
    byId,
  };
}
