import type { WorldSceneClientParams } from '@qvac/inference/surface'
import type { WorldSceneResult, WorldSceneResultWithPack } from '@/client/api/world-result'
import { worldCreateScene } from '@/client/api/world'

const base = {
  modelId: 'model-1',
  prompt: '| unknown | a path through a forest',
  image: new Uint8Array([1])
}

function expectWithPack(_r: WorldSceneResultWithPack) {}
function expectStatsOnly(_r: WorldSceneResult) {}

// An inline literal `true` reaches the pack-carrying shape.
expectWithPack(worldCreateScene({ ...base, returnPack: true }))

// Omitted and explicit `false` both land on the pack-free shape.
expectStatsOnly(worldCreateScene(base))
expectStatsOnly(worldCreateScene({ ...base, returnPack: false }))

// `scene` must not exist on the pack-free shape, or the opt-in means nothing.
// @ts-expect-error the pack was never requested
void worldCreateScene(base).scene

// The case the two-overload version got wrong. `returnPack` widens to
// `boolean | undefined` on a params object annotated with the public type, so a
// literal `true` written here is NOT visible to overload resolution. It must
// resolve to the union rather than silently claiming there is no pack.
const widenedTrue: WorldSceneClientParams = { ...base, returnPack: true }
const widenedResult = worldCreateScene(widenedTrue)
// @ts-expect-error the union is not assignable to the pack-carrying shape alone
expectWithPack(widenedResult)
// It IS assignable to the pack-free shape, since WithPack extends it — so the
// widened case never loses access to requestId/stats, only to `scene`.
expectStatsOnly(widenedResult)

// Narrowing is how a caller gets back to a usable type.
if ('scene' in widenedResult) {
  expectWithPack(widenedResult)
} else {
  expectStatsOnly(widenedResult)
}

// A runtime boolean behaves the same way.
declare const runtimeFlag: boolean
const runtimeResult = worldCreateScene({ ...base, returnPack: runtimeFlag })
if ('scene' in runtimeResult) {
  expectWithPack(runtimeResult)
} else {
  expectStatsOnly(runtimeResult)
}
