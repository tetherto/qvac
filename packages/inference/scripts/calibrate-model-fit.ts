// Desktop entry point for the calibration harness in
// `src/resources/model-fit/calibration/harness.ts`. Run from the package root
// after `npm run build`:
//
//   bare scripts/calibrate-model-fit.ts            # measure and print
//   bare scripts/calibrate-model-fit.ts --write    # also rewrite the fixture
//   bare scripts/calibrate-model-fit.ts --gpu      # model resident on a discrete GPU
//   bare scripts/calibrate-model-fit.ts --igpu     # model on an integrated GPU
//
// First run downloads the models and needs registry access. See METHODOLOGY.md.

import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { registerPlugin } from '../dist/index.js'
import { llmPlugin } from '../dist/plugins/builtin/llamacpp-completion/plugin.js'
import {
  CalibrationAbortedError,
  runModelFitCalibration,
  type CalibrationPass
} from '../dist/resources/model-fit/calibration/harness.js'

declare const Bare: { argv: string[]; exit(code?: number): never }

async function main() {
  const write = Bare.argv.includes('--write')
  // `--gpu` reads device memory; `--igpu` pins the integrated GPU and keeps RSS.
  const pass: CalibrationPass = Bare.argv.includes('--gpu')
    ? 'gpu'
    : Bare.argv.includes('--igpu') || Bare.argv.includes('--shared')
      ? 'shared'
      : 'cpu'

  registerPlugin(llmPlugin)

  const run = await runModelFitCalibration({ pass, log: (line) => console.log(line) })

  if (run.warnings.length > 0) {
    console.log(
      `\n${run.warnings.length} warning(s) above — re-run on a quiet host before shipping this fixture`
    )
  }

  if (write) {
    const target = path.join(
      os.cwd(),
      'src',
      'resources',
      'model-fit',
      'calibration',
      `${run.fixtureKey}.ts`
    )
    fs.writeFileSync(target, run.fixtureSource)
    console.log(`\nwrote ${target}`)
    console.log('remember to add the platform to calibration/index.ts and run prettier')
  } else {
    console.log(`\n----- BEGIN CALIBRATION FIXTURE ${run.fixtureKey}.ts -----`)
    console.log(run.fixtureSource)
    console.log(`----- END CALIBRATION FIXTURE ${run.fixtureKey}.ts -----`)
    console.log('re-run with --write to update the fixture in place')
  }

  // The registry client keeps handles open, so exit explicitly. Non-zero on a
  // failed gate so the CI job cannot go green.
  Bare.exit(run.heldOut.holds ? 0 : 1)
}

main().catch((error) => {
  if (error instanceof CalibrationAbortedError) {
    console.error(`calibration aborted (${error.reason}): ${error.message} No fixture written.`)
  } else {
    console.error('calibration failed:', error)
  }
  Bare.exit(1)
})
