/**
 * Type-level fixture pinning the runtime admission contract of the native
 * addon (see addon/src/addon/AddonJs.hpp `runJob` and the base
 * inference-addon-cpp `admissionToJs`):
 *
 *   - Accepted single admission:  `{ accepted: true, id: <number> }`
 *   - Rejected single admission:  `{ accepted: false }` — NO id property
 *   - Accepted batch admission:   `{ accepted: true, id: <number>, ids: string[] }`
 *   - Rejected batch admission:   `{ accepted: false, ids: string[] }` — NO id
 *   - `activeJobs()`:             synchronous number (addon.js LlamaInterface)
 *   - `finetune()`:               scheduler-minted numeric id when admitted,
 *                                 `false` when refused (runExclusiveJob)
 *
 * Compiled by `npm run test:dts` (tsc -p tsconfig.dts.json). Every assertion
 * below must type-check against the exported declarations, so the declaration
 * file cannot drift from the runtime contract again.
 */
import type {
  Addon,
  AddonRunJobResult,
  AddonBatchRunResult,
  FinetuneOptions
} from '../../index'

// -- Single admission ---------------------------------------------------------

// Accepted single admission carries the native-assigned job id.
const acceptedSingle = { accepted: true, id: 7 } satisfies AddonRunJobResult
void acceptedSingle

// Rejected single admission carries NO id: the binding only sets `id` when a
// job id was minted, so runtime hands JS a bare `{ accepted: false }`.
const rejectedSingle = { accepted: false } satisfies AddonRunJobResult
void rejectedSingle

// `accepted` must discriminate the union: inside the accepted branch the id
// is a number; inside the rejected branch no usable id exists.
declare const singleAdmission: AddonRunJobResult
if (singleAdmission.accepted) {
  const routedJobId: number = singleAdmission.id
  void routedJobId
} else {
  // @ts-expect-error — rejected admissions never carry a usable numeric id
  const phantomJobId: number = singleAdmission.id
  void phantomJobId
}

// -- Batch admission ----------------------------------------------------------

// Accepted batch admission carries the native group id (used by BatchHandler
// via `result.id`) alongside the per-sequence ids.
const acceptedBatch = { accepted: true, id: 3, ids: ['a'] } satisfies AddonBatchRunResult
void acceptedBatch

// Rejected batch admission still reports the (auto-)assigned sequence ids but
// carries NO group id.
const rejectedBatch = { accepted: false, ids: ['a', 'b'] } satisfies AddonBatchRunResult
void rejectedBatch

// `ids` is present on both branches; the group id only after acceptance.
declare const batchAdmission: AddonBatchRunResult
const sequenceIds: string[] = batchAdmission.ids
void sequenceIds
if (batchAdmission.accepted) {
  const groupId: number = batchAdmission.id
  void groupId
}

// -- Addon surface -------------------------------------------------------------

declare const addon: Addon

// index.js reads `this.addon.activeJobs()` synchronously on every admission
// pre-check, so the interface must expose it as a plain number.
const activeJobCount: number = addon.activeJobs()
void activeJobCount

// finetune resolves the scheduler-minted exclusive-job id when admitted and
// `false` when refused (native runExclusiveJob -> admissionToJs).
declare const finetuneParams: FinetuneOptions
declare const runFinetune: NonNullable<Addon['finetune']>
async function finetuneAdmission() {
  const admission: number | false = await runFinetune(finetuneParams)
  void admission
}
void finetuneAdmission
