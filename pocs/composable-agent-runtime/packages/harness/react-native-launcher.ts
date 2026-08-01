import harness from './generated/react-native/harness.js'
import { createHarnessReactNativeLauncher } from './lib/react-native-launcher.ts'
export {
  createHarnessReactNativeLauncher,
  type StartedHarnessMobileLauncher
} from './lib/react-native-launcher.ts'

export default createHarnessReactNativeLauncher(harness)
