import '@/worker/index'
import { deprecate } from '@/deprecate'

deprecate(
  'worker-entry',
  "'@qvac/sdk/dist/server/worker.js' is deprecated; use '@qvac/sdk/dist/src/worker/index.js'."
)
