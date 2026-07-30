// Consumer-side type test. Compiling `index.d.ts` on its own only proves the
// declaration parses; this proves the discriminated union actually narrows the
// way an SDK would rely on. Type-checked by `npm run test:dts`, never executed.

import { fitParams, FIT_STATUS } from '../../index'
import type { FitResult, FitReason, FitPlan } from '../../index'

declare function assertNever (value: never): never

const result: FitResult = fitParams({ modelPath: '/model.gguf' })

// The inventory is readable on every branch, before any narrowing.
const devices: number = result.nDevices
const accelerators: number = result.nGpuDevices
void devices
void accelerators

if (result.status === FIT_STATUS.SUCCESS) {
  // SUCCESS: the plan is fully present, no optional-chaining needed.
  const plan: FitPlan = result
  const ctx: number = result.nCtx
  const layers: number = result.nGpuLayers
  const split: number[] = result.tensorSplit
  const overrides: string[] = result.buftOverrides.map((o) => o.pattern)
  void plan
  void ctx
  void layers
  void split
  void overrides

  // The placement parameters the fitter may rewrite are part of the plan, so a
  // consumer reproducing the load can read them without narrowing further. If
  // one of these is ever dropped from `FitPlan`, this stops compiling — the
  // type-level counterpart to the runtime guard in fit.test.js.
  const splitMode: number = result.splitMode
  const mainGpu: number = result.mainGpu
  const typeK: number = result.typeK
  const typeV: number = result.typeV
  const flashAttnType: number = result.flashAttnType
  void splitMode
  void mainGpu
  void typeK
  void typeV
  void flashAttnType

  // `fits` is tied to the branch, not independent state.
  const fits: true = result.fits
  void fits
} else if (result.status === FIT_STATUS.FAILURE) {
  const reason: 'does-not-fit' = result.reason
  void reason

  // @ts-expect-error plan fields are not guaranteed on a failed fit
  const ctx: number = result.nCtx
  void ctx
} else {
  // Every remaining branch is an ERROR, with a cause the SDK can act on.
  const reason: 'model-unreadable' | 'no-backend-device' = result.reason
  void reason
}

// Exhaustiveness: adding a status without handling it must fail to compile.
function describe (r: FitResult): string {
  switch (r.status) {
    case FIT_STATUS.SUCCESS: return 'fits'
    case FIT_STATUS.FAILURE: return 'does not fit'
    case FIT_STATUS.ERROR: return r.reason
    default: return assertNever(r)
  }
}
void describe

// Reasons are a closed set, so a typo cannot silently become a valid check.
const valid: FitReason = 'no-backend-device'
void valid

// @ts-expect-error not a member of the reason union
const invalid: FitReason = 'out-of-memory'
void invalid
