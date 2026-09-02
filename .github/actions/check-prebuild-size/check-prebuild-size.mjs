import fs from 'node:fs'
import process from 'node:process'

import { measure, renderReport, parseLimitMb, exceedsLimit, formatMb, DEFAULT_TOP_COUNT } from './measure-prebuilds.mjs'

function appendStepSummary (report, env) {
  const target = env.GITHUB_STEP_SUMMARY
  if (!target) {
    return
  }
  fs.appendFileSync(target, report)
}

function fail (message) {
  process.stdout.write(`::error::${message}\n`)
  process.exitCode = 1
}

export function run (env = process.env) {
  const dir = env.PREBUILD_DIR
  if (!dir) {
    throw new Error('PREBUILD_DIR is required')
  }
  if (!fs.existsSync(dir)) {
    throw new Error(`PREBUILD_DIR does not exist: ${dir}`)
  }

  const limitMb = parseLimitMb(env.MAX_TOTAL_MB)
  const topCount = Number(env.TOP_COUNT ?? DEFAULT_TOP_COUNT)
  const measurement = measure(dir, { topCount })
  const report = renderReport(measurement, limitMb)

  process.stdout.write(`${report}\n`)
  appendStepSummary(report, env)

  if (exceedsLimit(measurement.bytes, limitMb)) {
    fail(
      `prebuilds total ${formatMb(measurement.bytes)} exceeds the configured limit of ${limitMb.toFixed(1)} MB. ` +
      'The published package is roughly this plus the JS layer, and npm rejects a package whose unpacked size is ' +
      'over its ceiling, so either trim what ships (GPU fatbin architectures and shader payloads dominate) or ' +
      'raise max-prebuild-mb deliberately.'
    )
  }

  return measurement
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
}
