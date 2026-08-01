import {
  createBinaryChannelMultiplexer,
  type CarrierStream
} from './mobile-multiplex.ts'

export interface StartedHarnessMobileLauncher {
  readonly ipc: import('streamx').Duplex
  readonly sdkIpc: import('streamx').Duplex
  readonly worklet: { terminate(): Promise<void> }
}

interface ReactNativeHarnessModule {
  start(
    options?: object,
    args?: readonly string[]
  ): Promise<{
    readonly ipc: CarrierStream & {
      terminate(): void
    }
  }>
}

export function createHarnessReactNativeLauncher(module: ReactNativeHarnessModule) {
  return {
    async start(
      _id: string,
      _options: object = {},
      args: readonly string[] = []
    ): Promise<StartedHarnessMobileLauncher> {
      const started = await module.start({}, args)
      const mux = createBinaryChannelMultiplexer(started.ipc)
      const ipc = mux.openChannel(1)
      const sdkIpc = mux.openChannel(2)
      return {
        ipc,
        sdkIpc,
        worklet: {
          async terminate() {
            mux.close()
            await Promise.resolve(started.ipc.terminate())
          }
        }
      }
    }
  }
}
