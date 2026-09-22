import type { CollectMode, Step, TestDefinition } from '../types/test-definition.js'
import type { Expectation } from '../schemas/expectations.js'
import { ValidationHelpers } from '../utils/validation-helpers.js'
import type { TestResult } from './consumer-base.js'

/**
 * Executes a declarative test body.
 *
 * The same interpreter runs on every client, which is what makes JS the
 * reference implementation rather than merely the first implementation: a
 * migrated test is verified by having JS reproduce, through these steps, what
 * its hand-written executor produced.
 *
 * The framework knows nothing about the SDK under test, so the consumer
 * supplies the bindings: how to load a model behind a resource key, how to
 * make a call, how to resolve an asset, and which named assertions exist.
 * Everything else — reference resolution, ordering, the model lifecycle
 * around a test, what counts as pass / fail / incomplete — lives here, once.
 *
 * An operation the bindings cannot serve is `incomplete`, never `failure`:
 * the test applies to this client, the client simply cannot run it yet.
 */

export interface StepBindings {
  /** Load the models behind these resource keys, returning their ids in order. */
  useModel(deps: string[]): Promise<string[]>

  /** Make one SDK call. `collect` says how to fold a streaming result. */
  call(method: string, params: Record<string, unknown>, collect?: CollectMode): Promise<unknown>

  /**
   * Resolve a bundled test asset for this platform.
   *
   * `form` is what to bind: `bytes` for the contents, `path` for a reference
   * the SDK can open itself. Which one an API wants is part of its contract,
   * and the path form is what a filesystem path on desktop and a bundled-asset
   * URI on mobile have in common.
   */
  asset?(kind: string, file: string, form: 'bytes' | 'path'): Promise<unknown>

  /**
   * The model source behind a resource key, without loading it.
   *
   * A test that drives `loadModel` itself needs the source as data, and the
   * source is the one thing in a definition that cannot be written down: it is
   * a per-client constant. The resource table already knows it, so this asks
   * the table rather than putting a filesystem path in the catalog.
   */
  modelSource?(dep: string): Promise<unknown>

  /**
   * Checks that are more than "contains this string", written once per client.
   *
   * `args` carries the step's `with` block, already reference-resolved, so an
   * assertion can compare the result against something the test set up rather
   * than only against a constant.
   */
  assertions?: Record<string, (value: unknown, args: Record<string, unknown>) => TestResult>

  /** Comparisons between two bound values, e.g. for a repeat-then-compare test. */
  comparisons?: Record<string, (left: unknown, right: unknown) => TestResult>

  /** Evict everything not in `keep` before a test runs. */
  evictAllExcept?(keep: Set<string>): Promise<void>
}

/**
 * Thrown by bindings to say "this client cannot serve that yet".
 *
 * The distinction matters: an unimplemented method or stream fold is a gap in
 * the client, not a failing test, and the two must not be reported the same
 * way. Any other error from a binding is a real failure.
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

    // Evict anything this test did not declare, so a run does not depend on
    // the order tests happened to arrive in.
    if (this.bindings.evictAllExcept) {
      const declared = new Set<string>()
      for (const step of steps) {
        if ('useModel' in step) for (const dep of step.useModel.deps) declared.add(dep)
      }
      await this.bindings.evictAllExcept(declared)
    }

    const scope: Record<string, unknown> = { params: definition.params ?? {} }

    try {
      const asserted = await this.runSteps(steps, scope, definition.expectation)
      if (!asserted) {
        return { passed: false, output: 'test body ran but asserted nothing' }
      }
      return asserted
    } catch (error: unknown) {
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
      // The first failing check decides the test. A migrated executor often
      // becomes several checks in a row — shape, then length, then value — and
      // without this a later passing one would mask an earlier failure.
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
      // The first declared model is addressable as $model, so the common
      // single-model test needs no explicit `as`.
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
      // `kind` and `file` resolve like any other value: a category whose tests
      // differ only in which fixture they use should carry one body and name
      // the file in its params.
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

    if ('callError' in step) {
      const params = this.callParams(step.callError.params, scope)
      try {
        await this.bindings.call(step.callError.method, params, step.callError.collect)
      } catch (error: unknown) {
        // A binding GAP is not the rejection this step came for. Without this
        // an unwired method or an unimplemented fold would be bound as though
        // the call had failed on purpose -- reporting `pass` for a test the
        // client never ran, because `errorContains: ''` matches the gap's own
        // message. The spec is explicit that a gap is `incomplete`, never a
        // verdict about behaviour.
        if (error instanceof StepIncompleteError) throw error
        if (error instanceof StepError && error.incomplete) throw error
        const e = error as { code?: string | number; message?: string; cause?: unknown }
        // `hasCause` and a present `code` are what an "errors are structured"
        // test asks about. Binding them here keeps that question answerable
        // without a step that reaches into a language's exception object.
        scope[step.callError.as] = {
          code: e.code === undefined ? '' : String(e.code),
          message: e.message ?? String(error),
          hasCause: e.cause !== undefined
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
          // An iteration that failed its own check must stop the repeat rather
          // than contribute a half-built value to `collectInto`.
          throw new StepError(failure.output ?? 'repeat iteration failed', failure.incomplete)
        }
        // The last binding a nested step made is what the iteration produced;
        // `collectInto` names the list of those, which is what the assertion
        // then runs against.
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
        this.resolve(step.compare.right, scope)
      )
    }

    throw new StepError(`unknown step operation: ${JSON.stringify(step)}`, true)
  }

  /**
   * Resolve a call's parameters, dropping the ones that resolved to nothing.
   *
   * An optional reference that is not there must leave the argument out
   * entirely, not pass it as null: an SDK that distinguishes "absent" from
   * "explicitly nothing" would otherwise see a different call than the test
   * meant to make, and the two clients would have to agree on which.
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
      if ('asset' in step) return step.asset.as
      if ('modelSource' in step) return step.modelSource.as
    }
    return undefined
  }

  /**
   * Replace `$name` / `$params.x` references, recursively.
   *
   * A trailing `?` marks the reference optional: a path that is not there
   * resolves to `undefined` instead of failing the step. Most calls in the
   * catalog take optional arguments, and without this every test would have to
   * restate its own params inside its steps just to leave one of them out.
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

/** Resolve a dotted path with optional [i] indexes. */
function walk(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const rawSegment of path.split('.')) {
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
 * Keep the report small while still comparable across clients: a full
 * embedding vector is thousands of floats, and what a cross-client diff needs
 * is the shape plus a stable sample.
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
    // Before the object branch on purpose: a typed array is not Array.isArray,
    // so it would reach Object.entries(), which materialises one pair per
    // element before the slice throws them away. That is the whole cost this
    // function exists to avoid, paid on every assert over audio or image bytes.
    // Hex, because the Python summariser has only bytes to work with and a
    // value that differed only in how each client spelled it would be reported
    // as drift.
    const view = value as unknown as { length: number; slice: (a: number, b: number) => unknown }
    const head = Array.from(view.slice(0, 8) as ArrayLike<number>)
      .map((byte) => (byte & 0xff).toString(16).padStart(2, '0'))
      .join('')
    return { kind: 'bytes', length: view.length, head }
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
