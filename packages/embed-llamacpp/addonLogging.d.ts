export interface AddonLogging {
  /**
   * Registers a callback for native addon logs.
   *
   * The callback receives only messages allowed by the model's `config.verbosity`
   * setting: `"0"` = ERROR, `"1"` = WARNING, `"2"` = INFO, `"3"` = DEBUG.
   */
  setLogger(callback: (priority: number, message: string) => void): void
  releaseLogger(): void
}

declare const addonLogging: AddonLogging
export default addonLogging
