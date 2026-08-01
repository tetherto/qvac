import {
  startHarnessComponent,
  startSyncComponent
} from './lib/adapters.ts'
import {
  createAssistantFacade,
  DEFAULT_ASSISTANT_INFERENCE,
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_STORAGE_PATH,
  type AssistantFacade
} from './lib/facade.ts'
import type {
  AssistantComponents,
  CreateAssistantOptions
} from './lib/contracts.ts'

export type {
  AssistantComponent,
  AssistantComponents,
  AssistantHarnessComponent,
  AssistantInference,
  AssistantInspection,
  AssistantLifecycleEvent,
  AssistantLifecycleEventType,
  AssistantRun,
  AssistantRunInput,
  AssistantStateEndpoint,
  AssistantSyncComponent,
  CreateAssistantOptions
} from './lib/contracts.ts'
export type { AssistantFacade } from './lib/facade.ts'
export {
  DEFAULT_ASSISTANT_INFERENCE,
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_STORAGE_PATH
} from './lib/facade.ts'

export function createAssistant(
  options: CreateAssistantOptions = {}
): AssistantFacade {
  const components =
    options.components ??
    createDesktopComponents(options)
  return createAssistantFacade(options, components)
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
        storagePath,
        logging: options.logging
      }),
    startHarness: ({ state }) =>
      startHarnessComponent(state, inference, options.logging)
  }
}
