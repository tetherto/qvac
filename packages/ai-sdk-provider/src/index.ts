export { createQvac, qvac } from './provider.js'
export type {
  ManagedQvacProvider,
  QvacExternalOptions,
  QvacManagedModel,
  QvacManagedOptions,
  QvacOptions,
  QvacProvider
} from './types.js'

// Managed-mode errors, so callers can `instanceof`-check what `createQvac({
// mode: 'managed' })` throws instead of string-matching messages. These are
// plain Error subclasses with no heavy imports, so external-mode users pay
// nothing for the re-export.
export {
  CliNotFoundError,
  DuplicateManagedModelError,
  MultipleDefaultManagedModelsError,
  PortAllocationFailedError,
  QvacManagedModeError,
  ServeExitedError,
  ServeSpawnFailedError,
  ServeStartTimeoutError,
  UnknownManagedModelError
} from './managed/errors.js'
export type { QvacManagedErrorCode } from './managed/errors.js'

export type { EndpointCategory, ModelConstant } from './models/types.js'
export { allModels } from './models/constants.js'
export * as models from './models/index.js'
