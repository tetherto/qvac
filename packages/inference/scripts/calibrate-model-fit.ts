// Calibration harness for assessModelFit — desktop entry point.
//
// The procedure lives in `src/resources/model-fit/calibration/harness.ts`
// (exported as `@qvac/inference/model-fit-calibration`); this script registers
// the LLM plugin, runs it on the current host, and writes the fixture. On a
// phone the same procedure runs inside the SDK e2e consumer's calibration
// plugin instead — see METHODOLOGY.md, "Mobile".
//
// Run from the package root, on the platform being calibrated, with bare ≥ 1.30
// (which runs TypeScript directly via type-stripping — the version the
// `engines` field already requires):
//
//   npm run build
//   bare scripts/calibrate-model-fit.ts            # measure and print
//   bare scripts/calibrate-model-fit.ts --write    # also rewrite the fixture
//   bare scripts/calibrate-model-fit.ts --gpu      # GPU-resident pass instead
//
// Models are downloaded on first run and cached, so the first pass is slow and
// needs registry access. See calibration/METHODOLOGY.md for what the numbers
// mean and how the held-out check works, and "RSS and mmap" there for why the
// CPU-forced platforms load weights with `load_mode: 'none'`.

import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { registerPlugin } from '../dist/index.js'
import { llmPlugin } from '../dist/plugins/builtin/llamacpp-completion/plugin.js'
import {
  CalibrationAbortedError,
  runModelFitCalibration
} from '../dist/resources/model-fit/calibration/harness.js'

declare const Bare: { argv: string[]; exit(code?: number): never }

async function main() {
  const write = Bare.argv.includes('--write')
  // `--gpu` calibrates the same models resident on the GPU instead: no device
  // override, the SDK's own load mode, and device memory as the counter.
  const gpuPass = Bare.argv.includes('--gpu')

  registerPlugin(llmPlugin)

  const run = await runModelFitCalibration({ gpuPass, log: (line) => console.log(line) })

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

  // Exit explicitly either way. The registry client keeps handles open, so a
  // returning main() leaves the process alive until the job times out — and the
  // fixture, already written, never reaches the upload step. Non-zero on a
  // failed gate so the CI job cannot rot green.
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
