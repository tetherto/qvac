export interface AddonLogging {
  setLogger(callback: (priority: number, message: string) => void): void
  releaseLogger(): void
}

declare const addonLogging: AddonLogging
export default addonLogging
