export interface AddonLogging {
  setLogger(callback: (priority: number, message: string) => void): void
  releaseLogger(): void
}

interface AddonLoggingBinding {
  setLogger: (callback: (priority: number, message: string) => void) => void
  releaseLogger: () => void
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
const binding = require('./binding') as AddonLoggingBinding

const addonLogging: AddonLogging = {
  setLogger: binding.setLogger,
  releaseLogger: binding.releaseLogger
}

export default addonLogging

module.exports = addonLogging
