import test from 'brittle'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Response } from '@qvac/inference/surface'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The worker path is read when the RPC client module loads, so set it first.
process.env['QVAC_WORKER_PATH'] = path.resolve(__dirname, 'fixtures/stream-close-worker.mjs')

async function load() {
  const { stream, close } = await import('@/client/rpc/rpc-client')
  const { loggingStream } = await import('@/client/api/logging-stream')
  const { subscribeServerLogs } = await import('@/client/api/subscribe-logs')
  const { SDK_ALL_LOG_ID } = await import('@/logging')
  return { stream, close, loggingStream, subscribeServerLogs, SDK_ALL_LOG_ID }
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`HUNG: ${what}`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

type LogResponse = Response & { message: string }

// The fixture reports on a probe stream when a stream opens and when the client
// closes one, which is what the worker would see. One worker serves the file.
const probeController = new AbortController()
let probe: AsyncGenerator<Response> | undefined
let probeRead: Promise<IteratorResult<Response>> | undefined

async function nextReport(): Promise<string> {
  if (!probe) {
    const { stream } = await load()
    probe = stream({ type: 'loggingStream', id: 'probe' }, { signal: probeController.signal })
    probeRead = probe.next()
  }
  const result = await within(probeRead!, 5000, 'no report from the worker')
  probeRead = probe.next()
  return (result.value as LogResponse).message
}

test('aborting a stream() parked on a quiet id ends it and closes the request on the worker', async function (t) {
  t.timeout(30_000)
  const { stream } = await load()

  const controller = new AbortController()
  const read = stream({ type: 'loggingStream', id: 'quiet' }, { signal: controller.signal }).next()
  t.is(await nextReport(), 'opened:quiet', 'the worker holds the stream open')

  controller.abort()

  const result = await within(read, 2000, 'the pending read did not end on abort')
  t.ok(result.done, 'the pending read ends without an error and without another entry')
  t.is(await nextReport(), 'closed:quiet', 'the worker sees the stream closed')
})

test('a stream() delivers responses until it is aborted', async function (t) {
  t.timeout(30_000)
  const { stream } = await load()

  const controller = new AbortController()
  const responses = stream({ type: 'loggingStream', id: 'chatty' }, { signal: controller.signal })
  const first = await within(responses.next(), 5000, 'no entry from the worker')
  t.is((first.value as LogResponse).message, 'hello', 'the entry arrives')
  t.is(await nextReport(), 'opened:chatty', 'the worker holds the stream open')

  controller.abort()

  t.ok((await within(responses.next(), 2000, 'the read did not end')).done, 'the next read ends')
  t.is(await nextReport(), 'closed:chatty', 'the worker sees the stream closed')
})

test('a stream() with an aborted signal sends nothing', async function (t) {
  t.timeout(30_000)
  const { stream } = await load()

  const controller = new AbortController()
  controller.abort()
  const never = stream({ type: 'loggingStream', id: 'never' }, { signal: controller.signal })
  t.ok((await never.next()).done, 'the stream ends at once')

  const marker = new AbortController()
  const read = stream({ type: 'loggingStream', id: 'marker' }, { signal: marker.signal }).next()
  t.is(await nextReport(), 'opened:marker', 'the next stream the worker sees is the later one')
  marker.abort()
  await read
  t.is(await nextReport(), 'closed:marker', 'the worker sees the stream closed')
})

test('loggingStream passes its signal to the RPC stream', async function (t) {
  t.timeout(30_000)
  const { loggingStream } = await load()

  const controller = new AbortController()
  const read = loggingStream({ id: 'model-a' }, { signal: controller.signal }).next()
  t.is(await nextReport(), 'opened:model-a', 'the worker holds the stream open')

  controller.abort()

  t.ok((await within(read, 2000, 'loggingStream did not end on abort')).done, 'the stream ends')
  t.is(await nextReport(), 'closed:model-a', 'the worker sees the stream closed')
})

test('the unsubscribe from subscribeServerLogs closes the stream without another entry', async function (t) {
  t.timeout(30_000)
  const { subscribeServerLogs, SDK_ALL_LOG_ID } = await load()

  const unsubscribe = subscribeServerLogs(() => {})
  t.is(await nextReport(), `opened:${SDK_ALL_LOG_ID}`, 'the global stream is open on the worker')

  unsubscribe()

  t.is(await nextReport(), `closed:${SDK_ALL_LOG_ID}`, 'the worker sees it closed')
})

test('close the worker', { hook: true }, async function () {
  const { close } = await load()
  probeController.abort()
  // Let the probe's pending read end on its abort before close() fails it.
  await probeRead
  await close()
  delete process.env['QVAC_WORKER_PATH']
})
