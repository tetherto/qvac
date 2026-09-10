import { z } from 'zod'
import { definePlugin, defineHandler } from '@qvac/sdk'
import { CalibrationAbortedError, runModelFitCalibration } from '@qvac/sdk/model-fit-calibration'

// Runs the calibration harness inside the worker and streams progress out; the
// final chunk carries the whole run, which is how the fixture leaves a phone.

const requestSchema = z.object({}).passthrough()

const chunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('log'), line: z.string() }),
  z.object({ type: z.literal('aborted'), reason: z.string(), message: z.string() }),
  z.object({ type: z.literal('result'), run: z.object({}).passthrough() })
])

// Drops the GGUF facts from each measurement to keep the test output readable.
function summarize(run) {
  return {
    platform: run.platform,
    fixtureKey: run.fixtureKey,
    profile: run.profile,
    pass: run.pass,
    backendDevices: run.backendDevices,
    ...(run.loadMode ? { loadMode: run.loadMode } : {}),
    backend: run.backend,
    ...(run.device ? { device: run.device } : {}),
    cpuForced: run.cpuForced,
    measurements: run.measurements.map((m) => ({
      name: m.name,
      contextTokens: m.contextTokens,
      artifactBytes: m.artifactBytes,
      persistentBytes: m.persistentBytes,
      workingBytes: m.workingBytes,
      kvBytes: m.kvBytes,
      ...(m.backendDevice ? { backendDevice: m.backendDevice } : {})
    })),
    fit: run.fit,
    calibration: run.calibration,
    heldOut: run.heldOut,
    warnings: run.warnings,
    fixtureSource: run.fixtureSource
  }
}

const calibrationPlugin = definePlugin({
  modelType: 'calibration',
  displayName: 'Model-fit calibration (e2e)',
  addonPackage: 'custom-calibration-plugin',
  skipPrimaryModelPathValidation: true,
  loadConfigSchema: z.object({}).passthrough(),

  createModel() {
    return {
      model: {
        async load() {},
        unload() {}
      }
    }
  },

  handlers: {
    calibrate: defineHandler({
      requestSchema,
      responseSchema: chunkSchema,
      streaming: true,
      async *handler() {
        // Bridge the harness's log callback into this generator.
        const queue = []
        let wake = null
        let settled = false
        let run = null
        let failure = null

        function push(item) {
          queue.push(item)
          if (wake) {
            wake()
            wake = null
          }
        }

        runModelFitCalibration({ log: (line) => push({ type: 'log', line }) })
          .then((result) => {
            run = result
            settled = true
            push(null)
          })
          .catch((error) => {
            failure = error
            settled = true
            push(null)
          })

        while (true) {
          while (queue.length > 0) {
            const item = queue.shift()
            if (item) yield item
          }
          if (settled) break
          await new Promise((resolve) => {
            wake = resolve
          })
        }

        if (failure) {
          if (failure instanceof CalibrationAbortedError) {
            yield { type: 'aborted', reason: failure.reason, message: failure.message }
            return
          }
          throw failure
        }
        yield { type: 'result', run: summarize(run) }
      }
    })
  }
})

export default calibrationPlugin
