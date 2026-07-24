import crashBundle from '../generated/crash.remote.js'
import sdkBundle from '../generated/sdk.remote.js'
import {
  crashAndroidRuntime,
  startAndroidRuntime
} from './android-runtime-bridge'

export const androidSdkHarness = {
  async start(id: string, _options = {}, args: string[] = []) {
    return startAndroidRuntime(await sdkBundle.resolve(id, args))
  },

  async crash(id: string) {
    crashAndroidRuntime(await crashBundle.resolve(id))
  }
}
