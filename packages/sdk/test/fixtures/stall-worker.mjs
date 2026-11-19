// Worker for the deadline tests: the SDK worker with one plugin whose handlers
// stall. The JS, Python and Kotlin host tests all start this entry.
//
// A handler that takes `release` parks until a later `release` invoke names the
// same key, which stands in for a native job that finally stops.

import { z } from 'zod'
import { startWorker } from '../../dist/src/worker/start.js'

const released = new Map()

function gate(key) {
  let entry = released.get(key)
  if (!entry) {
    let open
    const opened = new Promise((resolve) => {
      open = resolve
    })
    entry = { opened, open }
    released.set(key, entry)
  }
  return entry
}

function untilAborted(context) {
  return new Promise((resolve) => {
    const signal = context?.signal
    if (!signal || signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

const stallParams = z.object({ key: z.string() })
const chunk = z.object({ n: z.number() })

const stallPlugin = {
  modelType: 'deadline-stall-test',
  displayName: 'Deadline stall',
  addonPackage: '@qvac/deadline-stall-test',
  loadConfigSchema: z.looseObject({}),
  skipPrimaryModelPathValidation: true,
  createModel: () => ({ model: { load: async () => {}, unload: async () => {} } }),
  handlers: {
    // Yields one chunk, then waits. Stops when aborted.
    stall: {
      requestSchema: z.object({}),
      responseSchema: chunk,
      streaming: true,
      handler: async function* (_params, _input, context) {
        yield { n: 1 }
        await untilAborted(context)
      }
    },
    // Yields one chunk, then waits for `release` and does not react to the abort.
    stallIgnoringAbort: {
      requestSchema: stallParams,
      responseSchema: chunk,
      streaming: true,
      handler: async function* (params) {
        yield { n: 1 }
        await gate(params.key).opened
      }
    },
    // A single reply that waits for `release` and does not react to the abort.
    hang: {
      requestSchema: stallParams,
      responseSchema: z.object({ done: z.boolean() }),
      streaming: false,
      handler: async (params) => {
        await gate(params.key).opened
        return { done: true }
      }
    },
    release: {
      requestSchema: stallParams,
      responseSchema: z.object({ released: z.boolean() }),
      streaming: false,
      handler: async (params) => {
        gate(params.key).open()
        released.delete(params.key)
        return { released: true }
      }
    }
  }
}

export default function start(ipc, ready) {
  return startWorker(ipc, ready, { plugins: [stallPlugin] })
}
