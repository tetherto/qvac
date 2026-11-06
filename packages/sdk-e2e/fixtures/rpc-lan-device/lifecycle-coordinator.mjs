export function createLifecycleCoordinator(engine) {
  let foreground = true
  let manualSuspension = false
  let terminal = false
  let closed = false
  let runtimeState
  let failure
  let pending = 0
  let tail = Promise.resolve()
  let closing
  const waiters = new Set()

  function wake() {
    for (const resolve of waiters) resolve()
    waiters.clear()
  }

  function assertOpen() {
    if (terminal) throw new Error('RPC LAN lifecycle coordinator is closing or closed')
  }

  function enqueue(work) {
    pending++
    const result = tail
      .catch(() => {})
      .then(work)
      .finally(() => {
        pending--
        wake()
      })
    tail = result
    void result.catch(() => {})
    return result
  }

  function report(operation, error) {
    engine.ontransition?.({
      operation,
      outcome: error ? 'failed' : 'succeeded',
      ...(runtimeState && !terminal && { runtimeState }),
      closing: terminal,
      closed,
      ...(error && { error: String(error).slice(0, 512) }),
      at: Date.now()
    })
  }

  function reconcile() {
    return enqueue(async () => {
      if (terminal) return
      const target = foreground && !manualSuspension ? 'active' : 'suspended'
      if (runtimeState === target && !failure) return
      const operation = target === 'active' ? 'resume' : 'suspend'
      let error
      try {
        await engine[operation]()
      } catch (cause) {
        error = cause
      }
      // Closing owns the engine now. A state query here could restart its worker.
      if (!terminal) {
        try {
          runtimeState = await engine.state()
          if (!error && runtimeState !== target) {
            error = new Error(`Expected runtime ${target}, observed ${runtimeState}`)
          }
        } catch (cause) {
          error ??= cause
          runtimeState = undefined
        }
      }
      failure = error
      report(operation, error)
      if (error) throw error
    })
  }

  async function whenActive() {
    for (;;) {
      assertOpen()
      const current = tail
      try {
        await current
      } catch (error) {
        if (current === tail) throw error
      }
      assertOpen()
      if (current !== tail) continue
      if (failure) throw failure
      if (foreground && !manualSuspension && runtimeState === 'active' && !pending) return
      await new Promise((resolve) => waiters.add(resolve))
    }
  }

  return {
    get closing() {
      return terminal
    },
    get closed() {
      return closed
    },
    setForeground(active) {
      assertOpen()
      if (foreground === active && runtimeState && !failure) return tail
      foreground = active
      return reconcile()
    },
    suspend() {
      assertOpen()
      manualSuspension = true
      return reconcile()
    },
    resume() {
      assertOpen()
      manualSuspension = false
      return reconcile()
    },
    async run(work) {
      for (;;) {
        await whenActive()
        assertOpen()
        if (!foreground || manualSuspension || pending) continue
        // Task bodies stay outside the transition queue so backgrounding can suspend them.
        const result = await work()
        assertOpen()
        return result
      }
    },
    close(cleanup = async () => {}) {
      if (closing) return closing
      terminal = true
      wake()
      closing = enqueue(async () => {
        const errors = []
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
        try {
          await engine.close()
          closed = true
        } catch (error) {
          errors.push(error)
        }
        const error = errors.length
          ? new AggregateError(errors, 'RPC LAN teardown failed')
          : undefined
        report('close', error)
        if (error) throw error
      })
      return closing
    }
  }
}
