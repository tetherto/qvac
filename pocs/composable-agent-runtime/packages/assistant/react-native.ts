import {
  createAssistantFacade,
  DEFAULT_ASSISTANT_INFERENCE,
  DEFAULT_ASSISTANT_STORAGE_PATH,
  type AssistantFacade
} from './lib/facade.ts'
import { createReactNativeAssistantComponents } from './lib/react-native-adapters.ts'
import type { AssistantInference, CreateAssistantOptions } from './lib/contracts.ts'
import { installAssistantConfig } from './lib/config.ts'

export type {
  AssistantAgentRegistration,
  AssistantInference,
  AssistantInspection,
  AssistantLifecycleEvent,
  AssistantLifecycleEventType,
  AssistantRun,
  AssistantRunInput,
  AssistantRunKey,
  AssistantRunRecord,
  AssistantStateEndpoint,
  AssistantWorkEndpoint,
  CreateAssistantOptions
} from './lib/contracts.ts'
export type { AssistantFacade } from './lib/facade.ts'
export {
  DEFAULT_ASSISTANT_INFERENCE,
  DEFAULT_ASSISTANT_STORAGE_PATH
} from './lib/facade.ts'

export interface CreateReactNativeAssistantOptions
  extends Pick<CreateAssistantOptions, 'storagePath' | 'logging'> {
  readonly invite?: string
  readonly inference?: AssistantInference
}

export function createAssistant(
  options: CreateReactNativeAssistantOptions = {}
): AssistantFacade {
  installAssistantConfig(options.logging)
  const storagePath = options.storagePath ?? DEFAULT_ASSISTANT_STORAGE_PATH
  const inference = options.inference ?? DEFAULT_ASSISTANT_INFERENCE
  const components = createReactNativeAssistantComponents({
    storagePath,
    invite: options.invite,
    inference
  })
  return createAssistantFacade(options, components)
}
