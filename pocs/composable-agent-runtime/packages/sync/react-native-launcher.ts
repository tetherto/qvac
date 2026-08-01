import syncHarness from './generated/react-native/sync.js'
import { createReactNativeSyncLauncher } from './lib/react-native-launcher.ts'

export { createReactNativeSyncLauncher, createSyncRuntimeArgs } from './lib/react-native-launcher.ts'
export default createReactNativeSyncLauncher({
  startHarness: async (_id, _options = {}, args = []) => {
    const started = await syncHarness.start({}, args)
    return {
      ipc: started.ipc,
      worklet: {
        async terminate() {
          await Promise.resolve(started.ipc.terminate())
        }
      }
    }
  }
})
