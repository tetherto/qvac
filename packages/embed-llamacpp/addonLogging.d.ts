export interface AddonLogging {
  /**
   * Registers a callback for native addon logs.
   *
   * The callback receives only messages at or above the addon's current
   * verbosity threshold: `"0"` = ERROR, `"1"` = WARNING, `"2"` = INFO,
   * `"3"` = DEBUG. The threshold is process-global and is updated from
   * `config.verbosity` each time a model is constructed, so when multiple
   * models are loaded the most recently constructed model's `config.verbosity`
   * applies to all subsequent native log dispatch.
   */
  setLogger(callback: (priority: number, message: string) => void): void
  releaseLogger(): void
}

declare const addonLogging: AddonLogging
export default addonLogging
