const ReadyResource = require('ready-resource')
const ReadyGuard = require('ready-guard')
const safetyCatch = require('safety-catch')

const DEFAULT_MAX_RESTARTS = 3
const DEFAULT_WINDOW = 30_000
const DEFAULT_BACKOFF = 1_000
const DEFAULT_MAX_BACKOFF = 30_000
const DEFAULT_STALL = 5_000

module.exports = class Supervisor extends ReadyResource {
  constructor(opts = {}) {
    super()
    this.stallTimeout = opts.stallTimeout ?? DEFAULT_STALL
    this._children = new Map()
    this._order = []
    this._queue = Promise.resolve()
    this._wake = null
    this._suspended = false
    this._suspendRan = false
  }

  add(name, spec) {
    if (this.opening) throw new Error('Cannot add children after startup')
    if (this._children.has(name)) throw new Error('Duplicate child: ' + name)
    const factory = typeof spec === 'function' ? spec : null
    if (factory) spec = factory()
    this._children.set(name, {
      name,
      spec,
      factory,
      deps: [...new Set(spec.deps ?? [])],
      handle: null,
      releasing: null,
      guard: null,
      state: 'idle',
      lives: 0,
      epoch: 0,
      deaths: [],
      error: null,
      startedAt: null
    })
    return this
  }

  get(name) {
    const child = this._children.get(name)
    if (!child || child.state !== 'running') throw new Error('Child not running: ' + name)
    return child.handle
  }

  inspect() {
    return this._order.map((child) => ({
      name: child.name,
      state: child.state,
      lives: child.lives,
      deps: child.deps,
      error: child.error?.message,
      uptime: child.startedAt === null ? null : Date.now() - child.startedAt,
      deaths: child.deaths.length,
      info: child.state === 'running' ? child.spec.inspect?.(child.handle) : undefined
    }))
  }

  async suspend(opts = {}) {
    if (!this.opening || this.closing) return
    if (!this.opened) await this.ready().catch(safetyCatch)
    if (!this.opened || this.closing) return
    this._suspended = true
    this._wake?.() // a restart parked in backoff abandons now — suspend must not wait out the delay
    await this._transition(() => this._suspendAfter(opts.linger ?? 0))
  }

  async resume() {
    if (!this.opening || this.closing) return
    if (!this.opened) await this.ready().catch(safetyCatch)
    if (!this.opened || this.closing) return
    this._suspended = false
    this._wake?.() // a suspend parked in its linger window coalesces now
    await this._transition(() => this._resume())
  }

  async reload(name, spec) {
    const child = this._children.get(name)
    if (!child) throw new Error('Unknown child: ' + name)
    if (!this.opened) await this.ready()
    await this._transition(() => this._reload(child, spec))
  }

  async _open() {
    this._order = this._topo()
    // boot rides the queue so a boot-time death restarts after ready, never interleaved
    await this._transition(() => this._boot())
  }

  async _boot() {
    const started = []
    try {
      for (const child of this._order) {
        await this._startChild(child)
        started.push(child)
      }
    } catch (err) {
      // ready-resource skips _close after a failed _open — unwind the partial boot here
      for (const child of started.reverse()) await this._stopChild(child)
      throw err
    }
  }

  close() {
    // break any in-flight start before ready-resource awaits `opening`: a child wedged
    // before ready would otherwise deadlock close (boot) or hang the queue (restart)
    for (const child of this._order) {
      if (child.state === 'starting') {
        child.error = new Error(child.name + ' aborted while starting — supervisor closing')
        child.guard?.destroy(child.error)
      }
    }
    return super.close()
  }

  async _close() {
    this._wake?.()
    await this._queue
    for (const child of [...this._order].reverse()) {
      if (child.state === 'running' || child.state === 'stopping') await this._stopChild(child)
    }
  }

  // a resume inside the linger window cancels the whole suspend — hooks never fire;
  // the flag is checked before AND after the sleep (a resume can land before the
  // queued transition ever reaches its sleep — the wake fires into the void)
  async _suspendAfter(linger) {
    if (this.closing) return
    if (!this._suspended) {
      this.emit('suspend-coalesced')
      return
    }
    if (linger > 0) {
      await this._sleep(linger)
      if (this.closing) return
      if (!this._suspended) {
        this.emit('suspend-coalesced')
        return
      }
    }
    for (const child of [...this._order].reverse()) {
      if (child.state === 'running' && child.spec.suspend) await child.spec.suspend(child.handle)
    }
    this._suspendRan = true
  }

  async _resume() {
    if (this._suspendRan) {
      this._suspendRan = false
      for (const child of this._order) {
        if (child.state === 'running' && child.spec.resume) await child.spec.resume(child.handle)
      }
    }
    await this._reconcile() // deaths during suspension parked their children 'stopped'
  }

  // deliberate upgrade: no death accounting, fresh intensity budget for the new code
  async _reload(child, spec) {
    if (this.closing) return
    const next = spec ?? child.factory?.() ?? child.spec
    const nextDeps = new Set(next.deps ?? [])
    if (nextDeps.size !== child.deps.length || !child.deps.every((dep) => nextDeps.has(dep))) {
      throw new Error('reload must not change deps: ' + child.name)
    }
    const dependents = this._dependents(child)
    for (const d of [...dependents].reverse()) await this._stopChild(d)
    if (child.state === 'running' || child.state === 'stopping') await this._stopChild(child)
    child.spec = next
    child.deaths = []
    child.error = null
    try {
      await this._startChild(child)
    } catch (err) {
      child.state = 'stopped'
      child.error = err
      throw err // the reload caller owns a failed upgrade; a later reload reconciles dependents
    }
    this.emit('child-reloaded', { name: child.name })
    await this._reconcile()
  }

  _topo() {
    const indegree = new Map()
    for (const child of this._children.values()) {
      for (const dep of child.deps) {
        if (!this._children.has(dep)) throw new Error('Unknown dep: ' + dep)
      }
      indegree.set(child.name, child.deps.length)
    }
    const queue = [...this._children.values()].filter((child) => child.deps.length === 0)
    const order = []
    while (queue.length) {
      const child = queue.shift()
      order.push(child)
      for (const other of this._children.values()) {
        if (!other.deps.includes(child.name)) continue
        const left = indegree.get(other.name) - 1
        indegree.set(other.name, left)
        if (left === 0) queue.push(other)
      }
    }
    if (order.length !== this._children.size) throw new Error('Dependency cycle')
    return order
  }

  async _startChild(child) {
    await this._drainRelease(child) // a prior doomed start must finish releasing before we respawn
    child.state = 'starting'
    const epoch = ++child.epoch
    const guard = new ReadyGuard()
    child.guard = guard
    const starting = (async () => {
      const handle = await child.spec.start({
        get: (name) => this.get(name),
        onDeath: (error) => this._onDeath(child, epoch, error)
      })
      if (typeof handle?.ready === 'function') await handle.ready()
      return handle
    })()
    // if the guard wins the race, release whatever the doomed start eventually produced — the next start awaits this
    child.releasing = starting.then((handle) => {
      if (guard.destroyed) return this._release(child, handle)
    }, safetyCatch)
    // a start that neither readies nor dies would wedge the queue silently — surface it like stop/drain
    const stall = setTimeout(() => this.emit('stall', { name: child.name }), this.stallTimeout)
    try {
      // a death during startup destroys the guard, failing the start instead of hanging on a dead handle
      const handle = await Promise.race([starting, guard.ready()])
      if (guard.destroyed) throw child.error ?? new Error(child.name + ' died while starting')
      child.handle = handle
      child.releasing = null // this incarnation is the live handle — nothing to release
    } finally {
      clearTimeout(stall)
      guard.exit()
      child.guard = null
    }
    child.state = 'running'
    child.error = null
    child.lives++
    child.startedAt = Date.now()
    this.emit('child-ready', { name: child.name, lives: child.lives })
  }

  _release(child, handle) {
    if (handle === null || handle === undefined) return
    const stop =
      child.spec.stop ?? (typeof handle.close === 'function' ? () => handle.close() : null)
    if (stop) return Promise.resolve(stop(handle)).catch(safetyCatch)
  }

  // bound the drain: a handle whose ready() never settles must stall, not wedge the respawn
  async _drainRelease(child) {
    if (!child.releasing) return
    const releasing = child.releasing
    child.releasing = null
    let timer
    const stall = new Promise((resolve) => {
      timer = setTimeout(() => {
        this.emit('stall', { name: child.name })
        resolve()
      }, this.stallTimeout)
    })
    try {
      await Promise.race([releasing, stall])
    } finally {
      clearTimeout(timer)
    }
  }

  async _stopChild(child) {
    child.state = 'stopping'
    child.startedAt = null
    const handle = child.handle
    child.handle = null
    const stop =
      child.spec.stop ?? (typeof handle?.close === 'function' ? () => handle.close() : null)
    if (stop && handle !== null && handle !== undefined) {
      const timer = setTimeout(() => this.emit('stall', { name: child.name }), this.stallTimeout)
      try {
        await stop(handle)
      } catch (err) {
        safetyCatch(err) // best-effort: a dead handle's stop may reject
      } finally {
        clearTimeout(timer)
      }
    }
    child.state = 'stopped'
    this.emit('child-stopped', { name: child.name })
  }

  _onDeath(child, epoch, error) {
    if (epoch !== child.epoch) return
    const err = error ?? new Error(child.name + ' died')
    if (child.state === 'starting') {
      child.error = err
      child.guard?.destroy(err)
      return
    }
    if (this.closing || child.state !== 'running') return
    child.state = 'stopping'
    child.error = err
    this.emit('child-died', { name: child.name, error: err })
    this._transition(() => this._restart(child, epoch))
  }

  async _restart(child, epoch) {
    // stale: another transition already recycled this child
    if (this.closing || epoch !== child.epoch) return
    const dependents = this._dependents(child)
    for (const d of [...dependents].reverse()) await this._stopChild(d)
    await this._stopChild(child)
    child.deaths.push(Date.now())
    if (!(await this._revive(child))) return
    await this._reconcile()
  }

  // retry loop for one stopped child; true once running, false on gave-up or parked
  async _revive(child) {
    while (true) {
      if (this.closing || this._suspended) return false // resume reconciles parked children
      if (!this._depsRunning(child)) return false // a dep is down — its recovery reconciles us
      if (child.spec.restart === 'never' || this._exhausted(child)) {
        child.state = 'failed'
        this.emit('gave-up', { name: child.name, error: child.error })
        return false
      }
      const base = child.spec.backoff ?? DEFAULT_BACKOFF
      const cap = child.spec.maxBackoff ?? DEFAULT_MAX_BACKOFF
      // deaths are pruned to the window by _exhausted above — backoff doubles per death in it
      const delay = Math.min(base * 2 ** (child.deaths.length - 1), cap)
      this.emit('child-restarting', { name: child.name, delay })
      await this._sleep(delay)
      if (this.closing || this._suspended) return false
      if (!this._depsRunning(child)) return false
      try {
        await this._startChild(child)
        return true
      } catch (err) {
        child.error = err
        child.deaths.push(Date.now())
        child.state = 'stopped'
        this.emit('child-died', { name: child.name, error: err })
      }
    }
  }

  // start every stopped child whose deps run — concurrent deaths and suspension
  // strand dependents outside the restarting child's captured set
  async _reconcile() {
    for (const child of this._order) {
      if (this.closing || this._suspended) return
      if (child.state !== 'stopped' || !this._depsRunning(child)) continue
      try {
        await this._startChild(child)
      } catch (err) {
        child.error = err
        child.deaths.push(Date.now())
        child.state = 'stopped'
        this.emit('child-died', { name: child.name, error: err })
        await this._revive(child)
      }
    }
  }

  _exhausted(child) {
    const cutoff = Date.now() - (child.spec.window ?? DEFAULT_WINDOW)
    child.deaths = child.deaths.filter((t) => t >= cutoff)
    return child.deaths.length > (child.spec.maxRestarts ?? DEFAULT_MAX_RESTARTS)
  }

  // transitive dependents of child that are currently running, in start order
  _dependents(child) {
    const names = new Set([child.name])
    for (const other of this._order) {
      if (other.deps.some((dep) => names.has(dep))) names.add(other.name)
    }
    names.delete(child.name)
    return this._order.filter((other) => names.has(other.name) && other.state === 'running')
  }

  _depsRunning(child) {
    return child.deps.every((dep) => this._children.get(dep).state === 'running')
  }

  _transition(fn) {
    const run = this._queue.then(fn)
    this._queue = run.catch(safetyCatch)
    return run
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._wake = null
        resolve()
      }, ms)
      this._wake = () => {
        clearTimeout(timer)
        this._wake = null
        resolve()
      }
    })
  }
}
