export type ChildState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type RestartPolicy = 'always' | 'never'

export interface ChildContext {
  get<T = unknown>(name: string): T
  onDeath(error?: Error): void
}

export interface ChildSpec<T = unknown> {
  deps?: string[]
  restart?: RestartPolicy
  start(context: ChildContext): T | Promise<T>
  stop?(handle: T): void | Promise<void>
  suspend?(handle: T): void | Promise<void>
  resume?(handle: T): void | Promise<void>
  inspect?(handle: T): Record<string, unknown>
}

export interface ChildInspection {
  name: string
  state: ChildState
  deps: string[]
  lives: number
  error?: {
    name: string
    message: string
  }
  details?: Record<string, unknown>
}

export type SupervisorEventType =
  | 'child-ready'
  | 'child-died'
  | 'child-restarting'
  | 'child-stopped'
  | 'suspended'
  | 'resumed'

export interface SupervisorEvent {
  type: SupervisorEventType
  timestamp: number
  name?: string
  lives?: number
  error?: {
    name: string
    message: string
  }
}

interface ChildRecord {
  name: string
  spec: ChildSpec<unknown>
  deps: string[]
  state: ChildState
  handle: unknown
  lives: number
  epoch: number
  error?: Error
}

type EventListener = (event: SupervisorEvent) => void

export class Supervisor {
  private readonly children = new Map<string, ChildRecord>()
  private readonly listeners = new Set<EventListener>()
  private order: ChildRecord[] = []
  private transition: Promise<void> = Promise.resolve()
  private readyPromise?: Promise<void>
  private closePromise?: Promise<void>
  private closing = false
  private suspended = false

  add<T>(name: string, spec: ChildSpec<T>) {
    if (this.readyPromise !== undefined) {
      throw new Error('Cannot add children after startup')
    }
    if (this.children.has(name)) {
      throw new Error(`Duplicate child: ${name}`)
    }

    this.children.set(name, {
      name,
      spec: spec as ChildSpec<unknown>,
      deps: [...new Set(spec.deps ?? [])],
      state: 'idle',
      handle: undefined,
      lives: 0,
      epoch: 0
    })
    return this
  }

  ready() {
    this.readyPromise ??= this.enqueue(async () => {
      this.order = this.topologicalOrder()
      const started: ChildRecord[] = []
      try {
        for (const child of this.order) {
          await this.startChild(child)
          started.push(child)
        }
      } catch (error) {
        for (const child of started.reverse()) await this.stopChild(child)
        throw error
      }
    })
    return this.readyPromise
  }

  close() {
    this.closing = true
    this.closePromise ??= this.enqueue(async () => {
      const order =
        this.order.length > 0 ? this.order : [...this.children.values()]
      for (const child of [...order].reverse()) await this.stopChild(child)
      this.suspended = false
    })
    return this.closePromise
  }

  get<T = unknown>(name: string) {
    const child = this.children.get(name)
    if (child?.state !== 'running') {
      throw new Error(`Child not running: ${name}`)
    }
    return child.handle as T
  }

  inspect() {
    const order =
      this.order.length > 0 ? this.order : [...this.children.values()]
    return order.map((child) => {
      const details =
        child.state === 'running' && child.spec.inspect !== undefined
          ? child.spec.inspect(child.handle)
          : undefined
      return {
        name: child.name,
        state: child.state,
        deps: [...child.deps],
        lives: child.lives,
        ...(child.error === undefined
          ? {}
          : { error: errorEnvelope(child.error) }),
        ...(details === undefined ? {} : { details })
      } satisfies ChildInspection
    })
  }

  onEvent(listener: EventListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async suspend() {
    await this.ready()
    await this.enqueue(async () => {
      if (this.closing || this.suspended) return
      this.suspended = true
      for (const child of [...this.order].reverse()) {
        if (child.state === 'running' && child.spec.suspend !== undefined) {
          await child.spec.suspend(child.handle)
        }
      }
      this.emit({ type: 'suspended', timestamp: Date.now() })
    })
  }

  async resume() {
    await this.ready()
    await this.enqueue(async () => {
      if (this.closing || !this.suspended) return
      for (const child of this.order) {
        if (child.state === 'running' && child.spec.resume !== undefined) {
          await child.spec.resume(child.handle)
        }
      }
      this.suspended = false
      this.emit({ type: 'resumed', timestamp: Date.now() })
    })
  }

  async reload(_name: string): Promise<never> {
    throw new Error('reload is not implemented in this PoC')
  }

  private topologicalOrder() {
    const remainingDependencies = new Map<string, number>()
    for (const child of this.children.values()) {
      for (const dependency of child.deps) {
        if (!this.children.has(dependency)) {
          throw new Error(`Unknown dependency: ${dependency}`)
        }
      }
      remainingDependencies.set(child.name, child.deps.length)
    }

    const queue = [...this.children.values()].filter(
      (child) => child.deps.length === 0
    )
    const order: ChildRecord[] = []
    while (queue.length > 0) {
      const child = queue.shift()
      if (child === undefined) break
      order.push(child)
      for (const candidate of this.children.values()) {
        if (!candidate.deps.includes(child.name)) continue
        const remaining =
          (remainingDependencies.get(candidate.name) ?? 0) - 1
        remainingDependencies.set(candidate.name, remaining)
        if (remaining === 0) queue.push(candidate)
      }
    }

    if (order.length !== this.children.size) {
      throw new Error('Dependency cycle')
    }
    return order
  }

  private async startChild(child: ChildRecord) {
    if (this.closing) return
    child.state = 'starting'
    child.error = undefined
    const epoch = ++child.epoch
    try {
      const handle = await child.spec.start({
        get: <T>(name: string) => this.get<T>(name),
        onDeath: (error?: Error) => this.signalDeath(child, epoch, error)
      })
      if (this.closing || child.epoch !== epoch) {
        await this.releaseHandle(child, handle)
        child.state = 'stopped'
        return
      }
      child.handle = handle
      child.state = 'running'
      child.lives++
      this.emit({
        type: 'child-ready',
        timestamp: Date.now(),
        name: child.name,
        lives: child.lives
      })
    } catch (error) {
      child.state = 'failed'
      child.error = asError(error)
      throw child.error
    }
  }

  private async stopChild(child: ChildRecord) {
    if (
      child.state === 'idle' ||
      child.state === 'stopped' ||
      (child.handle === undefined && child.state === 'failed')
    ) {
      child.state = 'stopped'
      return
    }

    child.state = 'stopping'
    child.epoch++
    const handle = child.handle
    child.handle = undefined
    await this.releaseHandle(child, handle)
    child.state = 'stopped'
    this.emit({
      type: 'child-stopped',
      timestamp: Date.now(),
      name: child.name
    })
  }

  private async releaseHandle(child: ChildRecord, handle: unknown) {
    if (handle === undefined || child.spec.stop === undefined) return
    try {
      await child.spec.stop(handle)
    } catch {
      // Teardown is best effort in this architecture PoC.
    }
  }

  private signalDeath(
    child: ChildRecord,
    epoch: number,
    error = new Error(`${child.name} died`)
  ) {
    if (
      this.closing ||
      child.epoch !== epoch ||
      child.state !== 'running'
    ) {
      return
    }

    child.state = 'stopping'
    child.error = error
    this.emit({
      type: 'child-died',
      timestamp: Date.now(),
      name: child.name,
      error: errorEnvelope(error)
    })
    void this.enqueue(() => this.restart(child))
  }

  private async restart(child: ChildRecord) {
    if (this.closing) return
    const dependents = this.runningDependents(child.name)
    for (const dependent of [...dependents].reverse()) {
      await this.stopChild(dependent)
    }
    await this.stopChild(child)

    if (child.spec.restart === 'never' || this.suspended) {
      child.state = child.spec.restart === 'never' ? 'failed' : 'stopped'
      return
    }

    this.emit({
      type: 'child-restarting',
      timestamp: Date.now(),
      name: child.name
    })
    await this.startChild(child)
    for (const dependent of dependents) await this.startChild(dependent)
  }

  private runningDependents(name: string) {
    const names = new Set([name])
    for (const child of this.order) {
      if (
        child.state === 'running' &&
        child.deps.some((dependency) => names.has(dependency))
      ) {
        names.add(child.name)
      }
    }
    names.delete(name)
    return this.order.filter((child) => names.has(child.name))
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.transition.then(operation)
    this.transition = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private emit(event: SupervisorEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error('Unknown child error')
}

function errorEnvelope(error: Error) {
  return {
    name: error.name || 'Error',
    message: error.message || 'Unknown child error'
  }
}
