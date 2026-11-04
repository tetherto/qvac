import type { CollectMode, Step, TestDefinition } from '../types/test-definition.js'
import type { Expectation } from '../schemas/expectations.js'
import { ValidationHelpers } from '../utils/validation-helpers.js'
import type { TestResult } from './consumer-base.js'

/**
 * Executes a declarative test body. The consumer supplies the bindings; an operation they cannot
 * serve is `incomplete`, not `failure`.
 */

export interface StepBindings {
  /** Load the models behind these resource keys, returning their ids in order. */
  useModel(deps: string[]): Promise<string[]>

  /** Make one SDK call. `collect` says how to fold a streaming result. */
  call(method: string, params: Record<string, unknown>, collect?: CollectMode): Promise<unknown>

  /**
   * Resolve a bundled test asset. `form` is what to bind: `bytes` for the contents, `path` for a
   * reference the SDK opens itself.
   */
  asset?(kind: string, file: string, form: 'bytes' | 'path' | 'text'): Promise<unknown>

  /**
   * The model source behind a resource key, without loading it. Asked of the table rather than
   * written in the catalog: it is a per-client constant.
   */
  modelSource?(dep: string): Promise<unknown>

  /**
   * Checks beyond "contains this string", written once per client. `args` is the step's `with`
   * block, reference-resolved.
   */
  assertions?: Record<string, (value: unknown, args: Record<string, unknown>) => TestResult>

  /** Comparisons between two bound values, e.g. for a repeat-then-compare test. */
  comparisons?: Record<
    string,
    (left: unknown, right: unknown, args: Record<string, unknown>) => TestResult
  >

  /** Evict everything not in `keep` before a test runs. */
  evictAllExcept?(keep: Set<string>): Promise<void>
}

/**
 * Thrown by bindings to say "this client cannot serve that yet" -- a gap, not a failing test. Any
 * other error from a binding is a real failure.
 */
export class StepIncompleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepIncompleteError'
  }
}

class StepError extends Error {
  readonly incomplete: boolean

  constructor(message: string, incomplete = false) {
    super(message)
    this.name = 'StepError'
    this.incomplete = incomplete
  }
}

const INDEXED = /^(.*?)\[(\d+)\]$/

/** `field[*]` -- the rest of the path applied to every element. */
const WILDCARD = /^(.*?)\[\*\]$/

/**
 * A call `start` began and `settle` has yet to await. Held under a symbol so `project` cannot
 * mistake the pending promise for data.
 */
const PENDING = Symbol('pending')

/** The outcome of a started call, captured so awaiting it twice is safe. */
type Outcome = { value: unknown } | { error: unknown }

type Pending = { [PENDING]: Promise<Outcome> }

const isPending = (value: unknown): value is Pending =>
  typeof value === 'object' && value !== null && PENDING in value

/** Where the run collects started calls, so none outlive the test. */
const STARTED = '__started'

export class StepInterpreter {
  private readonly bindings: StepBindings

  constructor(bindings: StepBindings) {
    this.bindings = bindings
  }

  async run(definition: TestDefinition): Promise<TestResult> {
    const steps = definition.steps ?? []
    if (steps.length === 0) {
      return {
        passed: false,
        incomplete: true,
        incompleteReason: `${definition.testId} carries no steps`,
        output: `${definition.testId} carries no steps`
      }
    }

    // Evict anything this test did not declare, so a run does not depend on the order tests
    // happened to arrive in.
    if (this.bindings.evictAllExcept) {
      const declared = new Set<string>()
      // Teardown counts as declaration: a test that unloads its model in `finally` must not have it
      // evicted out from under the body.
      for (const step of [...steps, ...(definition.finally ?? [])]) {
        if ('useModel' in step) for (const dep of step.useModel.deps) declared.add(dep)
      }
      await this.bindings.evictAllExcept(declared)
    }

    const scope: Record<string, unknown> = { params: definition.params ?? {} }

    const body = await this.runBody(steps, scope, definition)
    const teardown = await this.runTeardown(definition, scope)
    await this.drainStarted(scope)
    return teardown ? this.merge(body, teardown) : body
  }

  private async runBody(
    steps: Step[],
    scope: Record<string, unknown>,
    definition: TestDefinition
  ): Promise<TestResult> {
    try {
      const asserted = await this.runSteps(steps, scope, definition.expectation)
      if (!asserted) {
        return { passed: false, output: 'test body ran but asserted nothing' }
      }
      return asserted
    } catch (error: unknown) {
      return this.asResult(error)
    }
  }

  /**
   * Runs the teardown steps, returning its failure or `undefined`. Runs on both paths and shares
   * the body scope, so a half-finished body still restores the client; bindings it never reached
   * are referenced optionally.
   */
  private async runTeardown(
    definition: TestDefinition,
    scope: Record<string, unknown>
  ): Promise<TestResult | undefined> {
    const steps = definition.finally ?? []
    if (steps.length === 0) return undefined
    let result: TestResult | undefined
    try {
      result = await this.runSteps(steps, scope, definition.expectation)
    } catch (error: unknown) {
      result = this.asResult(error)
    }
    return result && !result.passed ? result : undefined
  }

  /**
   * Folds a failed teardown into the body's result: a passing body cannot be claimed when cleanup
   * failed, and a failing one keeps its own diagnosis.
   */
  private merge(body: TestResult, teardown: TestResult): TestResult {
    if (body.passed) return { ...teardown, output: `teardown failed: ${teardown.output}` }
    return {
      ...body,
      output: `${body.output} [teardown also failed: ${teardown.output}]`
    }
  }

  /**
   * The run's started calls. In the scope so `repeat`'s per-iteration copy shares the array: a call
   * started in a loop is still the run's to drain.
   */
  private started(scope: Record<string, unknown>): Pending[] {
    const existing = scope[STARTED]
    if (Array.isArray(existing)) return existing as Pending[]
    const list: Pending[] = []
    scope[STARTED] = list
    return list
  }

  /**
   * Waits for every started call the test never settled, so an in-flight completion cannot land
   * inside the next test. Nothing here is reported.
   */
  private async drainStarted(scope: Record<string, unknown>): Promise<void> {
    const list = scope[STARTED]
    if (!Array.isArray(list)) return
    await Promise.all((list as Pending[]).map((pending) => pending[PENDING]))
  }

  private async settleWithin(
    pending: Promise<Outcome>,
    of: string,
    withinMs: number | undefined
  ): Promise<Outcome> {
    if (withinMs === undefined) return pending
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new StepError(`${of} did not settle within ${withinMs}ms`)),
        withinMs
      )
    })
    try {
      return await Promise.race([pending, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  private asResult(error: unknown): TestResult {
    if (error instanceof StepIncompleteError) {
      return {
        passed: false,
        incomplete: true,
        incompleteReason: error.message,
        output: error.message
      }
    }
    if (error instanceof StepError) {
      return error.incomplete
        ? {
            passed: false,
            incomplete: true,
            incompleteReason: error.message,
            output: error.message
          }
        : { passed: false, output: error.message }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { passed: false, output: message }
  }

  private async runSteps(
    steps: Step[],
    scope: Record<string, unknown>,
    expectation: Expectation
  ): Promise<TestResult | undefined> {
    let lastAssertion: TestResult | undefined

    for (const step of steps) {
      const result = await this.runStep(step, scope, expectation)
      if (!result) continue
      // The first failing check decides the test. A migrated executor often becomes several checks
      // in a row — shape, then length, then value — and without this a later passing one would mask
      // an earlier failure.
      if (!result.passed) return result
      lastAssertion = result
    }

    return lastAssertion
  }

  private async runStep(
    step: Step,
    scope: Record<string, unknown>,
    expectation: Expectation
  ): Promise<TestResult | undefined> {
    if ('useModel' in step) {
      const ids = await this.bindings.useModel(step.useModel.deps)
      if (step.useModel.as) {
        scope[step.useModel.as] = ids.length === 1 ? ids[0] : ids
      }
      // The first declared model is addressable as $model, so the common single-model test needs no
      // explicit `as`.
      if (scope.model === undefined) scope.model = ids[0]
      return undefined
    }

    if ('modelSource' in step) {
      if (!this.bindings.modelSource) {
        throw new StepError('this client cannot resolve model sources yet', true)
      }
      scope[step.modelSource.as] = await this.bindings.modelSource(
        String(this.resolve(step.modelSource.dep, scope))
      )
      return undefined
    }

    if ('asset' in step) {
      if (!this.bindings.asset) {
        throw new StepError('this client cannot resolve assets yet', true)
      }
      // `kind` and `file` resolve like any other value: a category whose tests differ only in which
      // fixture they use should carry one body and name the file in its params.
      scope[step.asset.as] = await this.bindings.asset(
        String(this.resolve(step.asset.kind, scope)),
        String(this.resolve(step.asset.file, scope)),
        step.asset.form ?? 'bytes'
      )
      return undefined
    }

    if ('call' in step) {
      const params = this.callParams(step.call.params, scope)
      const value = await this.bindings.call(step.call.method, params, step.call.collect)
      scope[step.call.as ?? 'result'] = value
      return undefined
    }

    if ('start' in step) {
      const params = this.callParams(step.start.params, scope)
      // Settled into an outcome record immediately: an unsettled rejection would otherwise take the
      // consumer process down.
      const pending: Pending = {
        [PENDING]: Promise.resolve(
          this.bindings.call(step.start.method, params, step.start.collect)
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        )
      }
      scope[step.start.as] = pending
      this.started(scope).push(pending)
      return undefined
    }

    if ('settle' in step) {
      const handle = this.resolve(step.settle.of, scope)
      if (!isPending(handle)) {
        throw new StepError(`settle: "${step.settle.of}" is not a started call`)
      }
      const outcome = await this.settleWithin(handle[PENDING], step.settle.of, step.settle.withinMs)
      if (step.settle.expect === 'reject') {
        if (!('error' in outcome)) {
          throw new StepError(`${step.settle.of} was expected to fail but resolved`)
        }
        if (outcome.error instanceof StepIncompleteError) throw outcome.error
        if (outcome.error instanceof StepError && outcome.error.incomplete) throw outcome.error
        // Bound the way `callError` binds a rejection, so one body can assert on a refusal however
        // the call that produced it was made.
        const e = outcome.error as { code?: string | number; message?: string; cause?: unknown }
        scope[step.settle.as ?? 'result'] = {
          code: e.code === undefined ? '' : String(e.code),
          message: e.message ?? String(outcome.error),
          hasCause: e.cause !== undefined,
          details: errorDetails(outcome.error)
        }
        return undefined
      }
      if ('error' in outcome) throw outcome.error
      scope[step.settle.as ?? 'result'] = outcome.value
      return undefined
    }

    if ('callError' in step) {
      const params = this.callParams(step.callError.params, scope)
      try {
        await this.bindings.call(step.callError.method, params, step.callError.collect)
      } catch (error: unknown) {
        // A binding gap is not the rejection this step came for: bound as one, an unwired method
        // would report `pass` for a test that never ran.
        if (error instanceof StepIncompleteError) throw error
        if (error instanceof StepError && error.incomplete) throw error
        const e = error as { code?: string | number; message?: string; cause?: unknown }
        // `hasCause` and a present `code` are what an "errors are structured" test asks about.
        // Binding them here keeps that question answerable without a step that reaches into a
        // language's exception object.
        scope[step.callError.as] = {
          code: e.code === undefined ? '' : String(e.code),
          message: e.message ?? String(error),
          hasCause: e.cause !== undefined,
          // Typed errors carry their own data -- the sizes a context overflow was measured against.
          // Asserting on the message would be asserting on prose.
          details: errorDetails(error)
        }
        return undefined
      }
      throw new StepError(`${step.callError.method} was expected to fail but resolved`)
    }

    if ('repeat' in step) {
      const items = this.resolve(step.repeat.over, scope)
      if (!Array.isArray(items)) {
        throw new StepError(`repeat.over "${step.repeat.over}" did not resolve to a list`)
      }
      const collected: unknown[] = []
      for (const item of items) {
        const inner: Record<string, unknown> = { ...scope, [step.repeat.as]: item }
        const failure = await this.runSteps(step.repeat.steps, inner, expectation)
        if (failure && !failure.passed) {
          // An iteration that failed its own check must stop the repeat rather than contribute a
          // half-built value to `collectInto`.
          throw new StepError(failure.output ?? 'repeat iteration failed', failure.incomplete)
        }
        // The last binding a nested step made is what the iteration produced; `collectInto` names
        // the list of those, which is what the assertion then runs against.
        collected.push(inner[this.lastBinding(step.repeat.steps) ?? 'result'])
      }
      scope[step.repeat.collectInto] = collected
      return undefined
    }

    if ('project' in step) {
      const source = this.resolve(step.project.from, scope)
      let value = walk(source, step.project.path)
      if (step.project.join !== undefined && Array.isArray(value)) {
        value = value.map((v) => String(v)).join(step.project.join)
      }
      if (step.project.count) {
        if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
          throw new StepError(`project count: "${step.project.path}" is not a list`)
        }
        value = (value as unknown[]).length
      }
      scope[step.project.as] = value
      return undefined
    }

    if ('assert' in step) {
      const value = this.resolve(step.assert.on, scope)
      if (step.assert.named) {
        const assertion = this.bindings.assertions?.[step.assert.named]
        if (!assertion) {
          throw new StepError(
            `named assertion "${step.assert.named}" is not in this client's registry`,
            true
          )
        }
        const args = this.resolve(step.assert.with ?? {}, scope) as Record<string, unknown>
        return { ...assertion(value, args), assertedValue: summarise(value) }
      }
      return {
        ...ValidationHelpers.validate(value, expectation),
        assertedValue: summarise(value)
      }
    }

    if ('compare' in step) {
      const comparison = this.bindings.comparisons?.[step.compare.named]
      if (!comparison) {
        throw new StepError(
          `named comparison "${step.compare.named}" is not in this client's registry`,
          true
        )
      }
      return comparison(
        this.resolve(step.compare.left, scope),
        this.resolve(step.compare.right, scope),
        (this.resolve(step.compare.with ?? {}, scope) ?? {}) as Record<string, unknown>
      )
    }

    throw new StepError(`unknown step operation: ${JSON.stringify(step)}`, true)
  }

  /**
   * Resolve a call's parameters, dropping the ones that resolved to nothing: an absent optional
   * argument must be left out, not passed as null.
   */
  private callParams(
    params: Record<string, unknown> | undefined,
    scope: Record<string, unknown>
  ): Record<string, unknown> {
    const resolved = this.resolve(params ?? {}, scope) as Record<string, unknown>
    return Object.fromEntries(Object.entries(resolved).filter(([, v]) => v !== undefined))
  }

  /** Name the last value a nested step list bound, for `repeat.collectInto`. */
  private lastBinding(steps: Step[]): string | undefined {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]
      if ('project' in step) return step.project.as
      if ('call' in step) return step.call.as ?? 'result'
      // `settle` binds a value; `start` binds an in-flight call, which is not something a loop can
      // collect.
      if ('settle' in step) return step.settle.as ?? 'result'
      if ('asset' in step) return step.asset.as
      if ('modelSource' in step) return step.modelSource.as
    }
    return undefined
  }

  /**
   * Replace `$name` / `$params.x` references, recursively. A trailing `?` marks one optional: it
   * resolves to `undefined` instead of failing the step.
   */
  private resolve(value: unknown, scope: Record<string, unknown>): unknown {
    if (typeof value === 'string' && value.startsWith('$')) {
      const optional = value.endsWith('?')
      const path = value.slice(1, optional ? -1 : undefined)
      if (!optional) return walk(scope, path)
      try {
        return walk(scope, path)
      } catch {
        return undefined
      }
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.resolve(v, scope))
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          this.resolve(v, scope)
        ])
      )
    }
    return value
  }
}

/**
 * The data a rejection carries beyond its code and message. Own enumerable fields only: `stack` is
 * about this client, `cause` is reported as a boolean.
 */
function errorDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {}
  const details: Record<string, unknown> = {}
  for (const key of Object.keys(error as Record<string, unknown>)) {
    if (key === 'stack' || key === 'message' || key === 'code' || key === 'cause') continue
    const value = (error as Record<string, unknown>)[key]
    if (typeof value === 'function') continue
    details[key] = value
  }
  return details
}

function walk(source: unknown, path: string): unknown {
  let current: unknown = source
  const segments = path.split('.')
  for (const [position, rawSegment] of segments.entries()) {
    const wildcard = WILDCARD.exec(rawSegment)
    if (wildcard) {
      if (wildcard[1]) {
        if (current === null || current === undefined) {
          throw new StepError(`path "${path}" walked off a null at "${wildcard[1]}"`)
        }
        const container = current as Record<string, unknown>
        if (!(wildcard[1] in container)) {
          throw new StepError(`path "${path}" has no "${wildcard[1]}"`)
        }
        current = container[wildcard[1]]
      }
      if (!Array.isArray(current)) {
        throw new StepError(`path "${path}" used [*] on a ${typeof current}`)
      }
      const rest = segments.slice(position + 1).join('.')
      return rest ? current.map((item) => walk(item, rest)) : current
    }

    const match = INDEXED.exec(rawSegment)
    const segment = match ? match[1] : rawSegment
    const index = match ? Number(match[2]) : undefined

    if (segment) {
      if (current === null || current === undefined) {
        throw new StepError(`path "${path}" walked off a null at "${segment}"`)
      }
      const container = current as Record<string, unknown>
      if (!(segment in container)) {
        throw new StepError(`path "${path}" has no "${segment}"`)
      }
      current = container[segment]
    }
    if (index !== undefined) {
      current = (current as unknown[])[index]
    }
  }
  return current
}

/**
 * Keep the report small but comparable across clients: a cross-client diff needs the shape plus a
 * stable sample, not thousands of floats.
 */
function summarise(value: unknown, depth = 0): unknown {
  if (depth > 3) return '…'
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      length: value.length,
      head: value.slice(0, 8).map((v) => summarise(v, depth + 1))
    }
  }
  if (ArrayBuffer.isView(value)) {
    // Before the object branch on purpose: a typed array is not Array.isArray, so Object.entries()
    // would materialise a pair per element.
    const view = value as unknown as {
      length: number
      BYTES_PER_ELEMENT?: number
      slice: (a: number, b: number) => unknown
    }
    const head = Array.from(view.slice(0, 8) as ArrayLike<number>)
    // Hex only for byte views, where both clients spell the sample the same way. A wider element is
    // a number, and Python would summarise it as one.
    if (view.BYTES_PER_ELEMENT === 1) {
      return {
        kind: 'bytes',
        length: view.length,
        head: head.map((byte) => (byte & 0xff).toString(16).padStart(2, '0')).join('')
      }
    }
    return { kind: 'array', length: view.length, head }
  }
  if (typeof value === 'string') {
    return value.length <= 512 ? value : `${value.slice(0, 512)}…`
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 16)
        .map(([k, v]) => [k, summarise(v, depth + 1)])
    )
  }
  return value
}
