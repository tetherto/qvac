import { sdkTree } from './tree.js'
import { runSdk } from './sdk.js'

export const sdk = () =>
  Object.assign(sdkTree(), { qvac: { where: 'launcher' as const, run: runSdk } })
