// A plugin whose handlers stall on purpose, for the deadline tests. A handler
// parks on a named gate; the test releases the gate to let the handler end,
// which stands in for a native job that finally stops.
import { z } from 'zod'
import { requestParent, type PluginHandlerContext, type QvacPlugin } from '@/schemas/plugin'
import { getRequestRegistry } from '@/runtime/index'

export const STALL_MODEL_TYPE = 'deadline-stall-test'

const gates = new Map<string, { opened: Promise<void>; open: () => void }>()

function gate(name: string) {
  let entry = gates.get(name)
  if (!entry) {
    let open: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    entry = { opened, open }
    gates.set(name, entry)
  }
  return entry
}

/** Lets every handler parked on `name` continue. */
export function releaseStall(name: string): void {
  gate(name).open()
  gates.delete(name)
}

function untilAbortedOr(opened: Promise<void>, context: PluginHandlerContext | undefined) {
  return new Promise<void>((resolve) => {
    void opened.then(resolve)
    const signal = context?.signal
    if (signal?.aborted) resolve()
    else signal?.addEventListener('abort', () => resolve(), { once: true })
  })
}

const stallParams = z.object({ gate: z.string() })

export const stallPlugin = {
  modelType: STALL_MODEL_TYPE,
  displayName: 'Deadline stall',
  addonPackage: '@qvac/deadline-stall-test',
  loadConfigSchema: z.looseObject({}),
  skipPrimaryModelPathValidation: true,
  createModel: () => ({ model: { load: async () => {}, unload: async () => {} } }),
  handlers: {
    // Yields one chunk, then waits. Stops when aborted.
    stall: {
      requestSchema: stallParams,
      responseSchema: z.object({ n: z.number() }),
      streaming: true,
      handler: async function* (
        params: { gate: string },
        _input: unknown,
        context?: PluginHandlerContext
      ) {
        yield { n: 1 }
        await untilAbortedOr(gate(params.gate).opened, context)
      }
    },
    // Yields one chunk, then waits and does not react to the abort.
    stallIgnoringAbort: {
      requestSchema: stallParams,
      responseSchema: z.object({ n: z.number() }),
      streaming: true,
      handler: async function* (params: { gate: string }) {
        yield { n: 1 }
        await gate(params.gate).opened
      }
    },
    // A single-reply handler that does not react to the abort.
    hang: {
      requestSchema: stallParams,
      responseSchema: z.object({ done: z.boolean() }),
      streaming: false,
      handler: async (params: { gate: string }) => {
        await gate(params.gate).opened
        return { done: true }
      }
    },
    ticks: {
      requestSchema: z.object({ count: z.number(), gapMs: z.number() }),
      responseSchema: z.object({ n: z.number() }),
      streaming: true,
      handler: async function* (params: { count: number; gapMs: number }) {
        for (let n = 1; n <= params.count; n++) {
          await new Promise<void>((resolve) => setTimeout(resolve, params.gapMs))
          yield { n }
        }
      }
    },
    // Holds the model's one `transcribe` slot until the gate opens, the way a
    // native job that ignores its cancel keeps the model busy.
    occupy: {
      requestSchema: stallParams,
      responseSchema: z.object({ done: z.boolean() }),
      streaming: false,
      handler: async (
        params: { gate: string; modelId?: string },
        _input: unknown,
        context?: PluginHandlerContext
      ) => {
        await using ctx = await getRequestRegistry().begin({
          requestId: `${context!.requestId}-inner`,
          ...requestParent(context),
          kind: 'transcribe',
          modelId: STALL_MODEL_ID
        })
        ctx.scope.defer(() => gate(params.gate).opened)
        if (!ctx.signal.aborted) await untilAbortedOr(gate(params.gate).opened, context)
        return { done: true }
      }
    },
    // Takes the same slot and returns at once.
    quick: {
      requestSchema: z.object({}),
      responseSchema: z.object({ done: z.boolean() }),
      streaming: false,
      handler: async (_params: unknown, _input: unknown, context?: PluginHandlerContext) => {
        await using ctx = await getRequestRegistry().begin({
          requestId: `${context!.requestId}-inner`,
          ...requestParent(context),
          kind: 'transcribe',
          modelId: STALL_MODEL_ID
        })
        return { done: !ctx.signal.aborted }
      }
    }
  }
} as unknown as QvacPlugin

export const STALL_MODEL_ID = 'deadline-stall-model'
