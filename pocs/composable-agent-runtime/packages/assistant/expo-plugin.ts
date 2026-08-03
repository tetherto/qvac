import { createAssistantExpoPlugin } from './lib/expo/plugin.ts'

export { composeAssistantStack, createAssistantExpoPlugin } from './lib/expo/plugin.ts'
export { finalizeAssistantStack } from './lib/expo/finalize.ts'
export { readPackageContributions } from './lib/expo/contribution.ts'
export type {
  ComposeAssistantStackOptions,
  CreateAssistantExpoPluginOptions,
  PackageContribution
} from './lib/expo/types.ts'

export default createAssistantExpoPlugin()
