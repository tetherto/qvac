import { createHarnessExpoPlugin } from './lib/expo/plugin.ts'

export { composeHarnessContribution } from './lib/expo/contribution.ts'
export { validateStandaloneContribution } from './lib/expo/finalize.ts'
export { createHarnessExpoPlugin } from './lib/expo/plugin.ts'
export type {
  CreateHarnessExpoPluginOptions,
  HarnessBuildResult,
  HarnessContribution
} from './lib/expo/types.ts'

export default createHarnessExpoPlugin()
