import {
  startHarnessComponent,
  startSyncComponent
} from './lib/adapters.ts'
import {
  createAssistantFacade,
  DEFAULT_ASSISTANT_INFERENCE,
  DEFAULT_ASSISTANT_STORAGE_PATH,
  type AssistantFacade
} from './lib/facade.ts'
import type { AssistantComponents, CreateAssistantOptions } from './lib/contracts.ts'
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

export function createAssistant(
  options: CreateAssistantOptions = {}
): AssistantFacade {
  installAssistantConfig(options.logging)
  return createAssistantFacade(options, createDesktopComponents(options))
}

function createDesktopComponents(
  options: CreateAssistantOptions
): AssistantComponents {
  const storagePath = options.storagePath ?? DEFAULT_ASSISTANT_STORAGE_PATH
  const inference = options.inference ?? DEFAULT_ASSISTANT_INFERENCE
  return {
    startSync: () =>
      startSyncComponent({
        ...options.sync,
        storagePath
      }),
    startHarness: ({ state }) =>
      startHarnessComponent(state, inference)
  }
}
