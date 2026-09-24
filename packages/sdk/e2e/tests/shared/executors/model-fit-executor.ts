import { assessModelFit, getLoadedModelInfo } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  modelFitAssessTests,
  modelFitProbeTests,
  modelFitTests
} from '../../model-fit-tests.js'

interface AssessParams {
  dep: string
  evidence: 'native-fit' | 'computed-only'
}

interface ProbeParams {
  dep: string
  engine: string
}

const REAL_VERDICTS = ['likely-fits', 'likely-too-large']

export class ModelFitExecutor extends AbstractModelExecutor<typeof modelFitTests> {
  pattern = /^model-fit-/

  protected handlers = {
    ...Object.fromEntries(modelFitAssessTests.map((t) => [t.testId, this.assess.bind(this)])),
    ...Object.fromEntries(modelFitProbeTests.map((t) => [t.testId, this.probe.bind(this)]))
  } as never

  /**
   * Assesses the load this dep would run, without running it. The engine
   * fitter reaching a verdict is what `evidence: 'native-fit'` reports, so it
   * stands for the whole chain: registry lookup, stub fetch, the plugin
   * resolving every companion source, and the addon's own `assessFit`.
   */
  async assess(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as AssessParams

    try {
      const load = await this.resources.loadParams(p.dep)
      const result = await assessModelFit({ models: [load] } as never)
      const model = result.models[0]

      if (!model) {
        return { passed: false, output: `No per-model result for dep="${p.dep}"` }
      }

      const checks: Record<string, boolean> = {
        evidenceMatches: result.evidence === p.evidence,
        perModelEvidenceMatches: model.evidence === p.evidence,
        oneModelAssessed: result.models.length === 1
      }

      if (p.evidence === 'native-fit') {
        checks['verdictIsReal'] = REAL_VERDICTS.includes(result.verdict)
        checks['probeProduced'] = (model.estimatorVersion ?? '').startsWith('native-probe')
        checks['engineGaveReason'] = (model.reasons[0] ?? '').length > 0
      } else {
        checks['neverConfirms'] = result.verdict !== 'likely-fits'
        checks['floorComputed'] = (result.floorBytes ?? 0) > 0
      }

      const summary =
        `dep=${p.dep}, verdict=${result.verdict}, evidence=${result.evidence ?? 'none'}, ` +
        `estimator=${model.estimatorVersion ?? 'none'}, reasons=[${model.reasons.join('; ')}], ` +
        `checks=${JSON.stringify(checks)}`

      if (!Object.values(checks).every(Boolean)) {
        return { passed: false, output: `Assessment mismatch: ${summary}` }
      }

      return ValidationHelpers.validate(summary, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `assessModelFit failed for dep="${p.dep}": ${errorMsg}` }
    }
  }

  /**
   * Reads the probe the load itself ran. The model is resident by the time
   * this runs, so a `does-not-fit` verdict is the fitter contradicting a load
   * that demonstrably succeeded.
   */
  async probe(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as ProbeParams

    try {
      const modelId = await this.resources.ensureLoaded(p.dep)
      const info = await getLoadedModelInfo({ modelId })
      const fit = info.fitProbe

      if (!fit) {
        return { passed: false, output: `No fitProbe on the loaded model for dep="${p.dep}"` }
      }

      const projection = fit.projection
      const measured =
        (projection?.deviceBytes ?? 0) > 0 ||
        (projection?.hostBytes ?? 0) > 0 ||
        (projection?.report ?? '').length > 0

      const checks = {
        basisIsProbe: fit.basis === 'native-probe',
        engineMatches: fit.engine === p.engine,
        fitsTheLoadThatSucceeded: fit.verdict === 'fit',
        projectionMeasured: measured
      }

      const summary =
        `dep=${p.dep}, engine=${fit.engine ?? 'none'}, verdict=${fit.verdict}, ` +
        `reason=${fit.reason}, device=${projection?.deviceBytes ?? 'none'}, ` +
        `host=${projection?.hostBytes ?? 'none'}, weights=${projection?.weightsBytes ?? 'none'}, ` +
        `context=${projection?.contextBytes ?? 'none'}, compute=${projection?.computeBytes ?? 'none'}, ` +
        `checks=${JSON.stringify(checks)}`

      if (!Object.values(checks).every(Boolean)) {
        return { passed: false, output: `Probe mismatch: ${summary}` }
      }

      return ValidationHelpers.validate(summary, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `fitProbe read failed for dep="${p.dep}": ${errorMsg}` }
    }
  }
}
