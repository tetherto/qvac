import { assessModelFit, getLoadedModelInfo, loggingStream, SDK_LOG_ID } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  modelFitAssessTests,
  modelFitProbeTests,
  modelFitTests,
  modelFitTogether
} from '../../../../catalog/model-fit-tests.js'

interface FitParams {
  dep: string
  measured: boolean
}

interface TogetherParams {
  deps: string[]
}

const MEASURED_VERDICTS = ['fits', 'does-not-fit']

const LLAMA_MODEL_TYPES = ['llamacpp-completion', 'llamacpp-embedding']

/** A llama load pinned to the CPU, which the llama fitters answer with `unknown`. */
function pinnedToCpu(load: { modelType?: unknown; modelConfig?: unknown }): boolean {
  if (!LLAMA_MODEL_TYPES.includes(String(load.modelType))) return false
  const device = (load.modelConfig as { device?: unknown } | undefined)?.device
  return typeof device === 'string' && device.toLowerCase() === 'cpu'
}

/**
 * Whether a verdict is what this engine owes: a measured engine reaches a
 * verdict unless the load runs on the CPU, and every other engine answers
 * `unknown`.
 */
function verdictMatches(measured: boolean, cpu: boolean, verdict: string): boolean {
  if (!measured) return verdict === 'unknown'
  if (cpu) return verdict === 'unknown'
  return MEASURED_VERDICTS.includes(verdict)
}

interface FitRows {
  pools: { usedBytes: number }[]
  models: { status: string; devices: { usedBytes: number }[] }[]
}

/** A model with a verdict reports the devices it uses; an unknown one reports none. */
function rowsMatchStatus(model: FitRows['models'][number]): boolean {
  return model.status === 'unknown' ? model.devices.length === 0 : model.devices.length > 0
}

/** The pools hold every model's rows, no more and no less. */
function poolsSumRows(result: FitRows): boolean {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const pooled = sum(result.pools.map((pool) => pool.usedBytes))
  const rows = sum(result.models.flatMap((model) => model.devices.map((row) => row.usedBytes)))
  return pooled === rows
}

const FIT_LOG_MARKERS = ['[model-fit]', '[advisory-fit:']
const STREAM_OPEN_DELAY_MS = 300
const STREAM_REOPEN_DELAY_MS = 100
const FIT_LOG_WAIT_MS = 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The SDK's fit log lines for one case, which name every pool and device row
 * behind a verdict. Opened before the case's setup, so a probe sees the line
 * its own load writes there.
 */
class FitLog {
  private lines: string[] = []
  private controller: AbortController | undefined

  async open(): Promise<void> {
    this.close()
    const controller = new AbortController()
    this.controller = controller
    this.lines = []
    const lines = this.lines
    void (async () => {
      // The setup can restart the worker before it loads the model, which ends
      // the stream; it reopens on the new worker until the case closes it.
      while (!controller.signal.aborted) {
        try {
          for await (const entry of loggingStream(
            { id: SDK_LOG_ID },
            { signal: controller.signal }
          )) {
            const { message } = entry as { message: string }
            if (FIT_LOG_MARKERS.some((marker) => message.includes(marker))) lines.push(message)
          }
        } catch {
          // A worker shutdown or the case's own abort ends this pass.
        }
        if (!controller.signal.aborted) await sleep(STREAM_REOPEN_DELAY_MS)
      }
    })()
    await sleep(STREAM_OPEN_DELAY_MS)
  }

  close(): void {
    this.controller?.abort()
    this.controller = undefined
  }

  /** The case's matching lines, waiting briefly for them to cross the RPC. */
  async collect(match: (line: string) => boolean = () => true): Promise<string[]> {
    const deadline = Date.now() + FIT_LOG_WAIT_MS
    for (;;) {
      const found = this.lines.filter(match)
      if (found.length > 0 || Date.now() >= deadline) return found
      await sleep(50)
    }
  }
}

/** Prints the fit lines under the case, and returns them for a failure's output. */
function reportFitLog(lines: string[]): string {
  const text = lines.length > 0 ? lines.join('\n') : 'no fit log line was received'
  for (const line of text.split('\n')) console.log(`   fit log: ${line}`)
  return `\n${text}`
}

export class ModelFitExecutor extends AbstractModelExecutor<typeof modelFitTests> {
  pattern = /^model-fit-/

  private readonly fitLog = new FitLog()

  override async setup(testId: string, context: unknown) {
    await this.fitLog.open()
    await super.setup(testId, context)
  }

  override async teardown(testId: string, context: unknown) {
    this.fitLog.close()
    await super.teardown(testId, context)
  }

  protected handlers = {
    ...Object.fromEntries(modelFitAssessTests.map((t) => [t.testId, this.assess.bind(this)])),
    [modelFitTogether.testId]: this.together.bind(this),
    ...Object.fromEntries(modelFitProbeTests.map((t) => [t.testId, this.probe.bind(this)]))
  } as never

  /**
   * Assesses the load this dep would run, without running it. A measured
   * verdict stands for the whole chain: registry lookup, stub fetch, the plugin
   * resolving every companion source, and the addon's own `assessFit`.
   */
  async assess(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as FitParams

    try {
      const load = await this.resources.loadParams(p.dep)
      const result = await assessModelFit({ models: [load] } as never)
      const model = result.models[0]
      const fitLog = reportFitLog(await this.fitLog.collect())

      if (!model) {
        return { passed: false, output: `No per-model result for dep="${p.dep}"${fitLog}` }
      }

      const cpu = pinnedToCpu(load)
      const checks = {
        oneModelAssessed: result.models.length === 1,
        verdictMatches: verdictMatches(p.measured, cpu, model.status),
        setFollowsTheModel: result.verdict === model.status || result.verdict === 'does-not-fit',
        rowsMatchStatus: rowsMatchStatus(model),
        poolsSumRows: poolsSumRows(result)
      }

      const summary =
        `dep=${p.dep}, verdict=${result.verdict}, model=${model.status}, cpu=${cpu}, ` +
        `devices=${JSON.stringify(model.devices)}, pools=${JSON.stringify(result.pools)}, ` +
        `stats=${JSON.stringify(model.stats)}, checks=${JSON.stringify(checks)}`

      if (!Object.values(checks).every(Boolean)) {
        return { passed: false, output: `Assessment mismatch: ${summary}${fitLog}` }
      }

      return ValidationHelpers.validate(summary, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `assessModelFit failed for dep="${p.dep}": ${errorMsg}` }
    }
  }

  /**
   * Assesses measured loads from different addons as one set. Each model must
   * reach a verdict, and the set must too: a pool both use sums their rows.
   */
  async together(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as TogetherParams

    try {
      const loads = await Promise.all(p.deps.map((dep) => this.resources.loadParams(dep)))
      const result = await assessModelFit({ models: loads } as never)
      const verdicts = result.models.map((model) => model.status)
      const fitLog = reportFitLog(await this.fitLog.collect())

      const checks = {
        everyModelAssessed: result.models.length === loads.length,
        everyModelMeasured: verdicts.every((verdict) => MEASURED_VERDICTS.includes(verdict)),
        setMeasured: MEASURED_VERDICTS.includes(result.verdict),
        setFollowsTheModels:
          result.verdict === 'does-not-fit' || verdicts.every((verdict) => verdict === 'fits'),
        everyModelReportsRows: result.models.every(rowsMatchStatus),
        poolsSumRows: poolsSumRows(result)
      }

      const summary =
        `deps=${p.deps.join('+')}, verdict=${result.verdict}, models=${verdicts.join(',')}, ` +
        `pools=${JSON.stringify(result.pools)}, checks=${JSON.stringify(checks)}`

      if (!Object.values(checks).every(Boolean)) {
        return { passed: false, output: `Assessment mismatch: ${summary}${fitLog}` }
      }

      return ValidationHelpers.validate(summary, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return {
        passed: false,
        output: `assessModelFit failed for deps="${p.deps.join('+')}": ${errorMsg}`
      }
    }
  }

  /** Reads the fit check the load itself ran. */
  async probe(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as FitParams

    try {
      const load = await this.resources.loadParams(p.dep)
      const modelId = await this.resources.ensureLoaded(p.dep)
      const info = await getLoadedModelInfo({ modelId })
      const fit = info.fitProbe
      // A model loaded by this case's setup wrote its line there; one still
      // resident from an earlier case wrote it then, outside this case's log.
      const fitLog = reportFitLog(
        await this.fitLog.collect((line) => line.includes(`:${modelId}]`))
      )

      if (!fit) {
        return {
          passed: false,
          output: `No fitProbe on the loaded model for dep="${p.dep}"${fitLog}`
        }
      }

      const cpu = pinnedToCpu(load)
      const model = fit.models[0]
      const checks = {
        oneModelChecked: fit.models.length === 1,
        verdictMatches: model !== undefined && verdictMatches(p.measured, cpu, model.status),
        rowsMatchStatus: model !== undefined && rowsMatchStatus(model),
        poolsSumRows: poolsSumRows(fit)
      }

      const summary =
        `dep=${p.dep}, verdict=${fit.verdict}, model=${model?.status}, cpu=${cpu}, ` +
        `devices=${JSON.stringify(model?.devices)}, pools=${JSON.stringify(fit.pools)}, ` +
        `checks=${JSON.stringify(checks)}`

      if (!Object.values(checks).every(Boolean)) {
        return { passed: false, output: `Probe mismatch: ${summary}${fitLog}` }
      }

      return ValidationHelpers.validate(summary, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `fitProbe read failed for dep="${p.dep}": ${errorMsg}` }
    }
  }
}
