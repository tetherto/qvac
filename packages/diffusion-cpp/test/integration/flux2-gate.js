'use strict'

const os = require('bare-os')
const proc = require('bare-process')

const isAppleParavirtualCi = () =>
  os.platform() === 'darwin' &&
  os.arch() === 'arm64' &&
  proc.env &&
  proc.env.GITHUB_ACTIONS === 'true' &&
  proc.env.RUNNER_ENVIRONMENT === 'github-hosted'

const getFlux2Skip = ({ label, isMobile, noGpu }) => {
  const skipFlux2 = proc.env && proc.env.SKIP_FLUX2_FUSION === 'true'
  const skipAppleParavirtual = isAppleParavirtualCi()
  const skip = isMobile || noGpu || skipFlux2 || skipAppleParavirtual

  console.log(
    `[${label}] Platform:`,
    os.platform(),
    'Arch:',
    os.arch(),
    'NO_GPU:',
    noGpu,
    'SKIP_FLUX2_FUSION:',
    skipFlux2,
    'RUNNER_ENVIRONMENT:',
    proc.env && proc.env.RUNNER_ENVIRONMENT,
    'Apple Paravirtual CI:',
    skipAppleParavirtual,
    '→ Skip:',
    skip
  )
  if (skipFlux2 || skipAppleParavirtual) {
    console.log(
      `[${label}] Skipped: Apple Paravirtual Metal does not support the ` +
        'MUL_MAT operation required by this test (workflow/runtime-scoped capability gate).'
    )
  }

  return skip
}

module.exports = { getFlux2Skip, isAppleParavirtualCi }
