import test from 'brittle'

// -----------------------------------------------------------------------------
// The browser `#rpc` client must fail, not hang, when its worker cannot start
// (asset 404, no OPFS in an insecure context, a throw during startup). A fake
// Worker reports an 'error' event the way the browser does.
// -----------------------------------------------------------------------------

class FailingWorker extends EventTarget {
  terminated = false
  constructor() {
    super()
    setTimeout(() => {
      const event = new Event('error') as Event & { message: string }
      event.message = 'Failed to fetch worker script'
      this.dispatchEvent(event)
    }, 10)
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated = true
  }
}

let started: FailingWorker | undefined
;(globalThis as { Worker?: unknown }).Worker = class extends FailingWorker {
  constructor() {
    super()
    started = this
  }
}

const { getRPC, getWorkerLifeSignal } = await import('@/client/rpc/browser-rpc-client')

test('browser rpc client: a worker that fails to start rejects getRPC', async (t) => {
  await t.exception(getRPC(), /QVAC browser worker error: Failed to fetch worker script/)
  t.ok(started?.terminated, 'the failed worker is terminated')
  t.is(getWorkerLifeSignal(), null, 'no live worker remains')
})
