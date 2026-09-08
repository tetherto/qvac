import { deprecate } from '@/deprecate'
import {
  ensureRPCSetup,
  cleanupForTerminate,
  initializeWorker,
  isWorkerInitialized,
  shutdownWorker,
  type WorkerShutdownReason
} from '@/worker/lifecycle'

deprecate(
  'worker-core',
  "'@qvac/sdk/worker-core' is deprecated; import from '@qvac/sdk/worker-lifecycle' " +
    '(initializeWorker, isWorkerInitialized, shutdownWorker, WorkerShutdownReason).'
)

export { ensureRPCSetup, cleanupForTerminate }
export const initializeWorkerCore = initializeWorker
export const isCoreInitialized = isWorkerInitialized
export const shutdownBareDirectWorker = shutdownWorker
export type BareDirectShutdownReason = WorkerShutdownReason
