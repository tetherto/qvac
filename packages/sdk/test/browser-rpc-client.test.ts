import test from 'brittle'
import RPC from 'bare-rpc'
import { decodeUtf8 } from '@/utils/encoding'
import { createWorkerPortStream, type WorkerPort } from '@/utils/worker-port-stream'
import { WorkerShutdownError } from '@/utils/errors-client'

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = []
  static nextInitDelayMs = 0
  static nextCloseDelayMs = 0
  static nextCloseFailures = 0

  readonly mounted = new Map<string, File>()
  readonly server: RPC
  terminated = false
  closed = false
  private workerMessageListener: ((event: MessageEvent) => void) | undefined
  private readonly initDelayMs: number
  private readonly closeDelayMs: number
  private closeFailures: number

  constructor() {
    super()
    this.initDelayMs = FakeWorker.nextInitDelayMs
    FakeWorker.nextInitDelayMs = 0
    this.closeDelayMs = FakeWorker.nextCloseDelayMs
    FakeWorker.nextCloseDelayMs = 0
    this.closeFailures = FakeWorker.nextCloseFailures
    FakeWorker.nextCloseFailures = 0
    FakeWorker.instances.push(this)

    const workerPort: WorkerPort = {
      postMessage: (message) => {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: message })))
      },
      addEventListener: (_type, listener) => {
        this.workerMessageListener = listener
      }
    }
    this.server = new RPC(createWorkerPortStream(workerPort), (req: RPC.IncomingRequest) => {
      const message = JSON.parse(decodeUtf8(req.data!)) as { type?: string }
      const reply = () => req.reply(JSON.stringify({ success: true }), 'utf8')
      if (message.type === '__init_config' && this.initDelayMs > 0) {
        setTimeout(reply, this.initDelayMs)
      } else {
        reply()
      }
    })
  }

  postMessage(message: unknown): void {
    if (message instanceof Uint8Array) {
      queueMicrotask(() =>
        this.workerMessageListener?.(new MessageEvent('message', { data: message }))
      )
      return
    }

    const control = message as {
      type?: string
      id?: number
      files?: Array<{ path: string; file: File }>
    }
    if (control.type === 'qvac:mount-files' && control.files) {
      if (control.files.some(({ file }) => file.name === 'fail.gguf')) {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'qvac:control-result',
                id: control.id,
                error: 'mount failed'
              }
            })
          )
        )
        return
      }
      for (const { path, file } of control.files) this.mounted.set(path, file)
    }
    if (control.type === 'qvac:mount-files') {
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'qvac:control-result', id: control.id }
          })
        )
      )
    }
    if (control.type === 'qvac:close') {
      if (this.closeFailures > 0) {
        this.closeFailures--
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'qvac:control-result',
                id: control.id,
                error: 'persistence failed'
              }
            })
          )
        )
        return
      }
      const acknowledge = () => {
        this.closed = true
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'qvac:control-result', id: control.id }
          })
        )
      }
      if (this.closeDelayMs > 0) setTimeout(acknowledge, this.closeDelayMs)
      else queueMicrotask(acknowledge)
    }
  }

  terminate(): void {
    this.terminated = true
  }

  crash(): void {
    const event = new Event('error') as ErrorEvent
    Object.defineProperties(event, {
      error: { value: new Error('worker crashed') },
      message: { value: 'worker crashed' }
    })
    this.dispatchEvent(event)
  }
}

Object.defineProperty(globalThis, 'Worker', {
  value: FakeWorker,
  configurable: true,
  writable: true
})

const { close, getRPC, getWorkerLifeSignal, mountBrowserFile, mountBrowserFiles } =
  await import('@/client/rpc/browser-rpc-client')

test('browser RPC serializes initialization, mounts files, and restarts cleanly', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const before = FakeWorker.instances.length
    const [first, second, third] = await Promise.all([getRPC(), getRPC(), getRPC()])
    t.is(first, second)
    t.is(second, third)
    t.is(FakeWorker.instances.length, before + 1, 'concurrent callers share one worker')

    const file = new File([`model-${iteration}`], `model-${iteration}.gguf`)
    const path = await mountBrowserFile(file)
    const worker = FakeWorker.instances.at(-1)!
    t.is(worker.mounted.get(path), file, 'mount is acknowledged before returning')

    const shards = [
      new File([`first-${iteration}`], 'model-00001-of-00002.gguf'),
      new File([`second-${iteration}`], 'model-00002-of-00002.gguf')
    ]
    const shardPaths = await mountBrowserFiles(shards)
    t.is(shardPaths.length, 2)
    t.is(
      shardPaths[0]!.slice(0, shardPaths[0]!.lastIndexOf('/')),
      shardPaths[1]!.slice(0, shardPaths[1]!.lastIndexOf('/'))
    )
    t.is(worker.mounted.get(shardPaths[0]!), shards[0])
    t.is(worker.mounted.get(shardPaths[1]!), shards[1])

    const life = getWorkerLifeSignal()
    await Promise.all([close(), close(), close()])
    t.ok(life?.aborted)
    t.ok(life?.reason instanceof WorkerShutdownError)
    t.ok(worker.closed, 'the worker acknowledges engine cleanup')
    t.ok(worker.terminated)
    t.is(getWorkerLifeSignal(), null)
  }
})

test('browser RPC close during initialization cannot resurrect a worker', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    FakeWorker.nextInitDelayMs = 25
    const starting = getRPC()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const worker = FakeWorker.instances.at(-1)!
    await close()
    await t.exception(starting, WorkerShutdownError)
    t.ok(worker.terminated)
    t.is(getWorkerLifeSignal(), null)
  }
})

test('browser RPC waits for persistence beyond the former shutdown grace period', async (t) => {
  const realSetTimeout = globalThis.setTimeout

  for (let iteration = 0; iteration < 20; iteration++) {
    FakeWorker.nextCloseDelayMs = 10_001
    await getRPC()
    const worker = FakeWorker.instances.at(-1)!
    const scheduled: number[] = []
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduled.push(timeout ?? 0)
      if ((timeout ?? 0) >= 10_000) {
        queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args)
        })
        return 1
      }
      return realSetTimeout(handler, timeout, ...args)
    }) as typeof setTimeout

    try {
      await close()
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    t.alike(scheduled, [10_001], 'close adds no competing persistence timeout')
    t.ok(worker.closed)
    t.ok(worker.terminated)
  }
})

test('browser RPC preserves a worker after persistence failure so close can retry', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    FakeWorker.nextCloseFailures = 1
    await getRPC()
    const worker = FakeWorker.instances.at(-1)!
    const life = getWorkerLifeSignal()!

    await t.exception(close(), /persistence failed/)
    t.is(getWorkerLifeSignal(), life)
    t.absent(life.aborted)
    t.absent(worker.terminated)
    t.absent(worker.closed)

    await close()
    t.ok(life.aborted)
    t.ok(worker.closed)
    t.ok(worker.terminated)
    t.is(getWorkerLifeSignal(), null)
  }
})

test('browser RPC worker failure aborts callers and allows a fresh start', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    await getRPC()
    const failed = FakeWorker.instances.at(-1)!
    const life = getWorkerLifeSignal()!
    failed.crash()
    t.ok(life.aborted)
    t.ok(failed.terminated)

    await getRPC()
    const replacement = FakeWorker.instances.at(-1)!
    t.not(replacement, failed)
    await close()
  }
})

test('browser RPC reports a file-mount failure without poisoning the worker', async (t) => {
  await getRPC()
  const failedGroup = [new File(['good'], 'first.gguf'), new File(['bad'], 'fail.gguf')]
  await t.exception(mountBrowserFiles(failedGroup), /mount failed/)
  const worker = FakeWorker.instances.at(-1)!
  t.is(worker.mounted.size, 0, 'a rejected group mounts no files')
  const path = await mountBrowserFile(new File(['good'], 'good.gguf'))
  t.ok(worker.mounted.has(path))
  await close()
})

test('browser RPC snapshots a group before worker initialization', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const original = new File(['model'], `model-${iteration}.gguf`)
    const files = [original]
    const mounting = mountBrowserFiles(files)
    files.splice(0, 1, new File(['other'], `other-${iteration}.gguf`))
    const paths = await mounting
    const worker = FakeWorker.instances.at(-1)!
    t.is(paths.length, 1)
    t.ok(paths[0]!.endsWith(`/model-${iteration}.gguf`))
    t.is(worker.mounted.get(paths[0]!), original)
    await close()
  }
})

test('browser RPC keeps mounted file names inside their generated directory', async (t) => {
  const before = FakeWorker.instances.length
  await t.exception(mountBrowserFile(new File(['model'], '..')), /must not be empty/)
  await t.exception(mountBrowserFile(new File(['model'], '.')), /must not be empty/)
  await t.exception(mountBrowserFile(new File(['model'], 'bad\0.gguf')), /null byte/)
  await t.exception(mountBrowserFiles([]), /At least one browser file/)
  await t.exception(
    mountBrowserFiles([new File(['a'], 'same.gguf'), new File(['b'], 'same.gguf')]),
    /unique names/
  )
  t.is(FakeWorker.instances.length, before, 'invalid groups do not start the worker')

  const path = await mountBrowserFile(new File(['model'], '../nested/model.gguf'))
  t.ok(path.startsWith('/.qvac/mounted/'))
  t.absent(path.includes('/../'))
  t.ok(path.endsWith('/model.gguf'))
  await close()
})
