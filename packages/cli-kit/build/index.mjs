// What a product's build scripts call: the standalone make, the npm pack, the dependency patches
// and the publish check, each given the product's root.
import { createRequire } from 'node:module'

export { make } from './make.mjs'
export { pack } from './pack.mjs'
export { patchDependencies, planPackagePatch } from './patch-dependencies.mjs'
export { checkPublishReady } from './publish-ready.mjs'
export const sidecarTarget = createRequire(import.meta.url)('./sidecar-target.cjs')
