import type { TestResult, Expectation } from '@qvac/test-suite'
import { calibrate, type CalibrationRunSummary } from 'custom-calibration-plugin/client'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { calibrationTests, calibrationModelFit } from '../../calibration-tests.js'

/**
 * Drives `custom-calibration-plugin` (`fixtures/calibration-plugin/`), which
 * runs the @qvac/inference model-fit harness inside the worker. Progress is
 * relayed to the console as it streams; the run itself becomes the test
 * output, so the producer's results JSON carries the fixture off the device.
 * The fixture is also echoed between markers for anyone reading the device
 * log directly.
 */
export class CalibrationExecutor extends AbstractModelExecutor<typeof calibrationTests> {
  pattern = /^calibration-/

  protected handlers = {
    [calibrationModelFit.testId]: this.modelFit.bind(this)
  }

  async modelFit(_params: Record<string, never>, _expectation: Expectation): Promise<TestResult> {
    try {
      const modelId = await this.resources.ensureLoaded('calibration')
      let run: CalibrationRunSummary | undefined
      let aborted: { reason: string; message: string } | undefined

      for await (const chunk of calibrate(modelId)) {
        if (chunk.type === 'log') {
          console.log(`[calibration] ${chunk.line}`)
        } else if (chunk.type === 'aborted') {
          aborted = { reason: chunk.reason, message: chunk.message }
        } else {
          run = chunk.run
        }
      }

      if (aborted) {
        console.log(`[calibration] aborted (${aborted.reason}): ${aborted.message}`)
        return { passed: false, output: JSON.stringify({ aborted }) }
      }
      if (!run) {
        return { passed: false, output: 'calibration stream ended without a result' }
      }

      console.log(`----- BEGIN CALIBRATION FIXTURE ${run.platform}.ts -----`)
      console.log(run.fixtureSource)
      console.log(`----- END CALIBRATION FIXTURE ${run.platform}.ts -----`)
      for (const warning of run.warnings) {
        console.log(`[calibration] warning: ${warning}`)
      }

      // A failed held-out check still returns the run: coefficients that did
      // not validate are worth auditing even though they must not ship.
      return { passed: run.calibration.validated, output: JSON.stringify(run) }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Calibration failed: ${msg}` }
    }
  }
}
