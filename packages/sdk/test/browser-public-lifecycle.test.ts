import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import RPC from 'bare-rpc'
import { decodeUtf8 } from '@/utils/encoding'
import { createWorkerPortStream, type WorkerPort } from '@/utils/worker-port-stream'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = []
  static nextMountFailure = false

  readonly mounted = new Map<string, File>()
  readonly server: RPC
  closeGate: Deferred | null
  closeFailures: number
  closeCrash: boolean
  closeRequests = 0
  terminated = false
  closed = false
  private workerMessageListener: ((event: MessageEvent) => void) | undefined
  private mountFailure: boolean

  constructor() {
    super()
    this.closeGate = null
    this.closeFailures = 0
    this.closeCrash = false
    this.mountFailure = FakeWorker.nextMountFailure
    FakeWorker.nextMountFailure = false
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
      const response =
        message.type === '__init_config' ? { success: true } : { type: 'heartbeat', number: 1 }
      req.reply(JSON.stringify(response), 'utf8')
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
      if (this.mountFailure) {
        this.mountFailure = false
        this.respond(control.id, 'mount failed')
        return
      }
      for (const { path, file } of control.files) this.mounted.set(path, file)
      this.respond(control.id)
      return
    }
    if (control.type !== 'qvac:close') return

    this.closeRequests++
    void (async () => {
      await this.closeGate?.promise
      if (this.closeCrash) {
        this.closeCrash = false
        this.crash()
        return
      }
      if (this.closeFailures > 0) {
        this.closeFailures--
        this.respond(control.id, 'persistence failed')
        return
      }
      this.closed = true
      this.respond(control.id)
    })()
  }

  terminate(): void {
    this.terminated = true
  }

  private respond(id: number | undefined, error?: string): void {
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'qvac:control-result', id, error }
        })
      )
    )
  }

  private crash(): void {
    const event = new Event('error') as ErrorEvent
    Object.defineProperties(event, {
      error: { value: new Error('worker crashed during close') },
      message: { value: 'worker crashed during close' }
    })
    this.dispatchEvent(event)
  }
}

Object.defineProperty(globalThis, 'Worker', {
  value: FakeWorker,
  configurable: true,
  writable: true
})

const browserRPC = await import('@/client/rpc/browser-rpc-client')
mock.module('#rpc', { exports: browserRPC })
const { close } = await import('@/client/rpc/rpc-client')
const { heartbeat } = await import('@/client/api/heartbeat')
const { mountBrowserFile } = await import('@/client/api/mount-browser-file')

test('public close recovers from a worker crash during persistence 20x', async () => {
  for (let iteration = 0; iteration < 20; iteration++) {
    await heartbeat()
    const failed = FakeWorker.instances.at(-1)!
    failed.closeCrash = true

    await assert.rejects(close(), /WORKER_CRASHED|Bare worker exited/)
    assert.equal(failed.terminated, true)

    await heartbeat()
    assert.notEqual(FakeWorker.instances.at(-1), failed)
    await close()
  }
})

test('public close stops mount-only workers after success or mount failure 20x', async () => {
  for (let iteration = 0; iteration < 20; iteration++) {
    await mountBrowserFile(new File(['model'], `model-${iteration}.gguf`))
    const mounted = FakeWorker.instances.at(-1)!
    await close()
    assert.equal(mounted.closed, true)
    assert.equal(mounted.terminated, true)

    FakeWorker.nextMountFailure = true
    await assert.rejects(
      mountBrowserFile(new File(['model'], `failed-${iteration}.gguf`)),
      /mount failed/
    )
    const failedMount = FakeWorker.instances.at(-1)!
    await close()
    assert.equal(failedMount.closed, true)
    assert.equal(failedMount.terminated, true)
  }
})

test('public requests and mounts wait for a successful close before restarting 20x', async () => {
  for (let iteration = 0; iteration < 20; iteration++) {
    await heartbeat()
    const original = FakeWorker.instances.at(-1)!
    const gate = deferred()
    original.closeGate = gate
    const closing = close()
    let requestSettled = false
    let mountSettled = false
    const request = heartbeat().finally(() => {
      requestSettled = true
    })
    const mounting = mountBrowserFile(new File(['model'], `model-${iteration}.gguf`)).finally(
      () => {
        mountSettled = true
      }
    )

    await Promise.resolve()
    assert.equal(FakeWorker.instances.at(-1), original)
    assert.equal(requestSettled, false)
    assert.equal(mountSettled, false)
    gate.resolve()
    await closing
    await request
    const path = await mounting

    const replacement = FakeWorker.instances.at(-1)!
    assert.notEqual(replacement, original)
    assert.equal(replacement.mounted.has(path), true)
    await close()
  }
})

test('public requests and mounts observe failed close before retry 20x', async () => {
  for (let iteration = 0; iteration < 20; iteration++) {
    await heartbeat()
    const worker = FakeWorker.instances.at(-1)!
    const gate = deferred()
    worker.closeGate = gate
    worker.closeFailures = 1
    const closing = close()
    const request = heartbeat()
    const mounting = mountBrowserFile(new File(['model'], `model-${iteration}.gguf`))

    gate.resolve()
    await assert.rejects(closing, /persistence failed/)
    await assert.rejects(request, /persistence failed/)
    await assert.rejects(mounting, /persistence failed/)
    assert.equal(worker.terminated, false)

    await close()
    await heartbeat()
    assert.notEqual(FakeWorker.instances.at(-1), worker)
    await close()
  }
})

test('concurrent public close shares delayed persistence and retry 20x', async () => {
  for (let iteration = 0; iteration < 20; iteration++) {
    await heartbeat()
    const worker = FakeWorker.instances.at(-1)!
    const gate = deferred()
    worker.closeGate = gate
    const settled = [false, false, false]
    const closings = settled.map((_, index) =>
      close().finally(() => {
        settled[index] = true
      })
    )
    await Promise.resolve()
    assert.deepEqual(settled, [false, false, false])
    gate.resolve()
    await Promise.all(closings)
    assert.equal(worker.closeRequests, 1)

    await heartbeat()
    const retryWorker = FakeWorker.instances.at(-1)!
    retryWorker.closeFailures = 1
    const failedClosings = [close(), close(), close()]
    const results = await Promise.allSettled(failedClosings)
    assert.equal(
      results.every((result) => result.status === 'rejected'),
      true
    )
    assert.equal(retryWorker.closeRequests, 1)
    assert.equal(retryWorker.terminated, false)

    await Promise.all([close(), close(), close()])
    assert.equal(retryWorker.closeRequests, 2)
    assert.equal(retryWorker.terminated, true)
  }
})
