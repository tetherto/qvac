/**
 * Compile-time contract test for the addon admission results (native
 * `runJob` / `admissionToJs`). Compiled by `npm run test:dts` so the
 * declarations in `index.d.ts` cannot drift from what the binding
 * actually returns:
 *
 *   - accepted admissions carry the scheduler-minted numeric `id`
 *   - rejected admissions carry NO id (`{ accepted: false }` bare)
 *   - batch results report per-sequence `ids` on both branches, the
 *     native group `id` only when accepted
 *   - `activeJobs()` is a synchronous number
 *   - `finetune()` resolves the exclusive-job id or `false`
 */
import type {
  Addon,
  AddonRunJobResult,
  AddonBatchRunResult,
  FinetuneOptions
} from '../../index'

// `accepted` must discriminate the single-admission union.
declare const single: AddonRunJobResult
if (single.accepted) {
  const routedJobId: number = single.id
  void routedJobId
} else {
  // @ts-expect-error — rejected admissions never carry a usable numeric id
  const phantomJobId: number = single.id
  void phantomJobId
}

// The exact literals runtime hands JS must stay assignable.
void ({ accepted: true, id: 7 } satisfies AddonRunJobResult)
void ({ accepted: false } satisfies AddonRunJobResult)

// Batch: `ids` on both branches, group `id` only after acceptance.
declare const batch: AddonBatchRunResult
const sequenceIds: string[] = batch.ids
void sequenceIds
if (batch.accepted) {
  const groupId: number = batch.id
  void groupId
} else {
  // @ts-expect-error — rejected batches never carry a group id
  const phantomGroupId: number = batch.id
  void phantomGroupId
}
void ({ accepted: true, id: 3, ids: ['a'] } satisfies AddonBatchRunResult)
void ({ accepted: false, ids: ['a', 'b'] } satisfies AddonBatchRunResult)

declare const addon: Addon

// index.js reads `activeJobs()` synchronously on every admission pre-check.
const activeJobCount: number = addon.activeJobs()
void activeJobCount

// finetune resolves the scheduler-minted exclusive-job id or `false`.
declare const finetuneParams: FinetuneOptions
declare const runFinetune: NonNullable<Addon['finetune']>
async function finetuneAdmission () {
  const admission: number | false = await runFinetune(finetuneParams)
  void admission
}
void finetuneAdmission
