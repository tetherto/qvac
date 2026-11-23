import type { BundleSdkOptions } from '@qvac/sdk/commands'

export type IosEngine = NonNullable<BundleSdkOptions['iosEngine']>

/** The engines Bare Kit can run an iOS worker with. */
export const IOS_ENGINES = ['javascriptcore', 'v8'] as const satisfies readonly IosEngine[]

export class BundleOptionsError extends Error {
  readonly option: string

  constructor(option: string, message: string) {
    super(message)
    this.name = 'BundleOptionsError'
    this.option = option
  }
}

/**
 * The iOS engine to bundle with, or undefined for the SDK's default. Only a
 * React Native worker runs on iOS, so the flag is refused for another target
 * rather than ignored.
 */
export function iosEngineFor(
  target: string,
  iosEngine: IosEngine | undefined
): IosEngine | undefined {
  if (iosEngine !== undefined && target !== 'react-native') {
    throw new BundleOptionsError(
      '--ios-engine',
      `--ios-engine applies to --target react-native, not ${target}.`
    )
  }
  return iosEngine
}
