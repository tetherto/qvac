import { assessModelFit, getLoadedModelInfo, getModelInfo } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { modelFitAssessTests, modelFitProbeTests, modelFitTests } from '../../model-fit-tests.js'

interface AssessParams {
  dep: string
  evidence: 'native-fit' | 'computed-only'
}

interface ProbeParams {
  dep: string
  engine: string
}

const REAL_VERDICTS = ['likely-fits', 'likely-too-large']

/**
 * The two stub failures that say nothing about this build. A missing record, a
 * missing blob and a corrupt one are defects, so none of them is listed here.
 */
const UNREACHABLE_REGISTRY = [
  'no registry description (timed-out)',
  'no registry description (download-failed)'
]

/** The device the resident instance resolved to, after the host's own load settings. */
async function residentDevice(modelId: string, modelName?: string): Promise<string | undefined> {
  if (modelName === undefined) return undefined
  const info = await getModelInfo({ name: modelName })
  const instance = info.loadedInstances?.find((entry) => entry.registryId === modelId)
  return (instance?.config as { device?: string } | undefined)?.device?.toLowerCase()
}

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
        oneModelAssessed: result.models.length === 1
      }

      // Only the fitters that read device memory alone decline a load the host
      // pinned to the CPU; the speech and voice fitters answer for one like any
      // other.
      const declinedOnCpu = model.device === 'cpu' && result.evidence !== 'native-fit'

      if (p.evidence !== 'native-fit') {
        checks['neverConfirms'] = result.verdict !== 'likely-fits'
      } else if (declinedOnCpu) {
        checks['noDeviceEvidence'] = true
      } else {
        checks['evidenceMatches'] = result.evidence === p.evidence
        checks['perModelEvidenceMatches'] = model.evidence === p.evidence
        checks['verdictIsReal'] = REAL_VERDICTS.includes(result.verdict)
        checks['probeProduced'] = (model.estimatorVersion ?? '').startsWith('native-probe')
        checks['engineGaveReason'] = (model.reasons[0] ?? '').length > 0
      }

      const summary =
        `dep=${p.dep}, verdict=${result.verdict}, evidence=${result.evidence ?? 'none'}, ` +
        `device=${model.device ?? 'none'}, estimator=${model.estimatorVersion ?? 'none'}, ` +
        `reasons=[${model.reasons.join('; ')}], setReasons=[${result.reasons.join('; ')}], ` +
        `checks=${JSON.stringify(checks)}`

      if (!Object.values(checks).every(Boolean)) {
        const unreachable = result.reasons.some((reason) =>
          UNREACHABLE_REGISTRY.some((prefix) => reason.includes(prefix))
        )
        if (unreachable) {
          return {
            passed: true,
            skipped: true,
            output: `SKIPPED: registry unreachable. ${summary}`
          }
        }

        return { passed: false, output: `Assessment mismatch: ${summary}` }
      }

      return ValidationHelpers.validate(summary, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `assessModelFit failed for dep="${p.dep}": ${errorMsg}` }
    }
  }

  /**
   * Reads the probe the load itself ran. A refusal has to be backed by its own
   * figures against a load that demonstrably succeeded; a CPU load carries no
   * device memory to weigh, so the fitter declines there.
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

      const deviceBytes = projection?.deviceBytes ?? 0
      const projectedBytes =
        (projection?.weightsBytes ?? 0) +
        (projection?.contextBytes ?? 0) +
        (projection?.computeBytes ?? 0)

      const device = await residentDevice(modelId, info.name)

      const checks =
        device === 'cpu'
          ? {
              basisIsProbe: fit.basis === 'native-probe',
              declinesWithoutDeviceMemory: fit.verdict === 'unknown'
            }
          : {
              basisIsProbe: fit.basis === 'native-probe',
              engineMatches: fit.engine === p.engine,
              verdictHoldsAgainstItsOwnFigures:
                fit.verdict === 'fit' ||
                (fit.verdict === 'does-not-fit' &&
                  deviceBytes > 0 &&
                  projectedBytes >= deviceBytes),
              projectionMeasured: measured
            }

      const summary =
        `dep=${p.dep}, engine=${fit.engine ?? 'none'}, verdict=${fit.verdict}, ` +
        `reason=${fit.reason}, detail=${fit.message ?? 'none'}, ` +
        `resolvedDevice=${device ?? 'unknown'}, ` +
        `device=${projection?.deviceBytes ?? 'none'}, ` +
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
