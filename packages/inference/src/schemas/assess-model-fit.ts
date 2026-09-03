import { z } from 'zod'
import { modelRegistryEntrySchema } from '@/schemas/registry'

/**
 * Advisory outcome of a pre-download fit assessment.
 *
 * `unknown` is a first-class answer, not a failure: it is what the SDK returns
 * whenever the evidence does not support a defensible claim either way.
 */
export const modelFitVerdictSchema = z.enum(['likely-fits', 'likely-too-large', 'unknown'])

/**
 * Normalized workload shapes. An engine's estimator declares which kinds it
 * supports; anything else assesses as `unknown`.
 *
 * Phase 1 covers LLM context and an audio window. Further kinds (fixed-cost
 * loads, text, image, video) are additive in later phases — a kind joins the
 * union only once an estimator actually handles it.
 */
export const modelFitWorkloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('llm'),
      contextTokens: z
        .number()
        .int()
        .positive()
        .describe('Context window the caller intends to use, in tokens.')
    })
    .describe('Token-context workload for llama.cpp completion and embedding models.'),
  z
    .object({
      kind: z.literal('audio'),
      windowMs: z
        .number()
        .positive()
        .describe('Audio window handed to the engine per call, in milliseconds.'),
      streaming: z.boolean().describe('Whether the caller streams continuously.'),
      batch: z.number().int().positive().optional().describe('Concurrent windows per call.')
    })
    .describe('Audio-window workload for speech-to-text models.')
])

/**
 * The part of a model constant an assessment reads. Pass a catalog constant
 * directly — the extra fields are ignored.
 *
 * Only the checksum (the profile lookup key) and the name (the result label)
 * are read; everything else — engine, byte totals, transformer facts — comes
 * from the resolved resource profile, not from the caller.
 */
export const modelFitModelRefSchema = modelRegistryEntrySchema.pick({
  name: true,
  sha256Checksum: true
})

/**
 * One model the caller is considering, with the workload it would run.
 *
 * @property model - A catalog model constant. The generated resource profile,
 *   looked up by checksum, supplies the byte totals and transformer facts.
 * @property artifacts - Extra catalog constants a compound load needs (a VAD
 *   model, a pivot model). Their artifact bytes are added to this candidate.
 */
export const modelFitCandidateSchema = z.object({
  model: modelFitModelRefSchema.describe('Catalog model constant to assess.'),
  artifacts: z
    .array(modelFitModelRefSchema)
    .optional()
    .describe('Additional catalog constants this load also requires.'),
  workload: modelFitWorkloadSchema.describe('Workload the caller intends to run.')
})

/**
 * How the caller intends to run the candidates. This is a **declared
 * assumption** used for aggregation, not a scheduling instruction — the SDK
 * neither enforces nor reserves anything.
 *
 * - `sequential`: every model stays resident, but only the largest single
 *   working-memory peak is counted.
 * - `concurrent`: every model stays resident and every peak is counted.
 */
export const modelFitExecutionSchema = z.enum(['sequential', 'concurrent'])

export const assessModelFitInputSchema = z.object({
  models: z
    .array(modelFitCandidateSchema)
    .min(1)
    .describe('Candidates to assess together under one memory budget.'),
  execution: modelFitExecutionSchema
    .default('sequential')
    .describe(
      'Declared co-residency assumption for aggregation. Not a scheduling instruction: the SDK does not serialize, reserve, or enforce anything.'
    ),
  policy: z
    .literal('interactive-v1')
    .default('interactive-v1')
    .describe(
      'Headroom policy. `interactive-v1` leaves the larger of 2 GiB or 15% of total RAM on desktop, 1 GiB or 20% on mobile.'
    )
})

const byteRangeSchema = z.object({
  lowerBoundBytes: z.number(),
  upperBoundBytes: z.number()
})

/**
 * What evidence the budget was derived from.
 *
 * - `system-memory`: total system RAM minus current use. The desktop model,
 *   and Android's — the low-memory killer acts system-wide.
 * - `process-memory`: this process's own ceiling. iOS jetsam terminates an app
 *   on its per-process footprint against a limit well below device RAM, so a
 *   system-wide budget there would defend verdicts the OS does not honor.
 */
export const modelFitBasisSchema = z.enum([
  'system-memory',
  'process-memory',
  'device-memory',
  'device-budget'
])

export const modelFitBudgetSchema = z.object({
  totalBytes: z
    .number()
    .describe(
      'Total budgetable memory under the result’s basis: system RAM, or the process ceiling (allowance plus current footprint) under process-memory.'
    ),
  usedBytes: z
    .number()
    .describe('Memory in use at sample time under the same basis (system-wide, or this process).'),
  reservedBytes: z.number().describe('Headroom withheld by the policy.'),
  availableAfterReserveBytes: z
    .number()
    .describe('Budget the estimate is compared against: total − used − reserved.')
})

export const modelFitModelResultSchema = z.object({
  name: z.string().describe('Catalog name of the assessed model.'),
  verdict: modelFitVerdictSchema,
  estimate: byteRangeSchema.optional().describe('Absent when this model assessed as `unknown`.'),
  estimatorVersion: z
    .string()
    .optional()
    .describe('Estimator that produced the bounds, e.g. `llm-v1`.'),
  reasons: z.array(z.string()).describe('Why this model got this verdict.')
})

export const assessModelFitResultSchema = z.object({
  verdict: modelFitVerdictSchema.describe('Combined verdict across every candidate.'),
  basis: modelFitBasisSchema.describe(
    'The evidence the budget was derived from — system RAM, the per-process ceiling on iOS, a discrete GPU’s own memory, or on Windows the GPU memory budget the OS grants this process. The two device bases also require the system-memory budget to hold.'
  ),
  execution: modelFitExecutionSchema.describe('The declared execution mode this result assumed.'),
  budget: modelFitBudgetSchema.optional().describe('Absent when memory evidence was unusable.'),
  estimate: byteRangeSchema.optional().describe('Absent when the combined verdict is `unknown`.'),
  models: z.array(modelFitModelResultSchema).describe('Per-candidate verdicts, in input order.'),
  reasons: z.array(z.string()).describe('Why the combined verdict came out this way.'),
  assumptions: z
    .array(z.string())
    .describe('Everything the result took for granted, including estimator defaults.')
})

export const assessModelFitRequestSchema = assessModelFitInputSchema.extend({
  type: z.literal('assessModelFit')
})

export const assessModelFitResponseSchema = assessModelFitResultSchema.extend({
  type: z.literal('assessModelFit')
})

export type ModelFitVerdict = z.infer<typeof modelFitVerdictSchema>
export type ModelFitModelRef = z.infer<typeof modelFitModelRefSchema>
export type ModelFitWorkload = z.infer<typeof modelFitWorkloadSchema>
export type ModelFitCandidate = z.infer<typeof modelFitCandidateSchema>
export type ModelFitExecution = z.infer<typeof modelFitExecutionSchema>
export type ModelFitBasis = z.infer<typeof modelFitBasisSchema>
export type ModelFitBudget = z.infer<typeof modelFitBudgetSchema>
export type ModelFitModelResult = z.infer<typeof modelFitModelResultSchema>
export type AssessModelFitInput = z.input<typeof assessModelFitInputSchema>
export type AssessModelFitResult = z.infer<typeof assessModelFitResultSchema>
export type AssessModelFitRequest = z.infer<typeof assessModelFitRequestSchema>
export type AssessModelFitResponse = z.infer<typeof assessModelFitResponseSchema>
