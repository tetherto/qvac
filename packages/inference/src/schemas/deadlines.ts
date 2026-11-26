import { z } from 'zod'

const deadlineMsSchema = z.number().int().positive()

/**
 * Deadlines one call asks the runtime to enforce. Each value can shorten the
 * runtime configuration's value for the same field, and never lengthens or
 * removes it.
 */
export const requestDeadlineSchema = z
  .object({
    queueMs: deadlineMsSchema
      .optional()
      .describe('Longest wait, in milliseconds, for an admission slot on the model.'),
    idleMs: deadlineMsSchema
      .optional()
      .describe(
        'Longest gap, in milliseconds, between two progress events of a streaming call. ' +
          'A response and a native progress event both count as progress.'
      ),
    runMs: deadlineMsSchema
      .optional()
      .describe('Longest run, in milliseconds, from admission to the end of the request.'),
    loadMs: deadlineMsSchema
      .optional()
      .describe(
        'Longest model load, in milliseconds, measured from the end of the download. ' +
          'Read only by `loadModel`.'
      )
  })
  // One title for every request that carries it, so the generated clients get
  // a single `RequestDeadline` type instead of one per request.
  .meta({ title: 'RequestDeadline' })

const nullableDeadlineMsSchema = deadlineMsSchema.nullable().optional()

/**
 * Deadlines for one capability. A field left out takes the value from
 * `default`; `null` removes that default for this capability.
 */
export const capabilityDeadlineSchema = z.object({
  queueMs: nullableDeadlineMsSchema,
  idleMs: nullableDeadlineMsSchema,
  runMs: nullableDeadlineMsSchema
})

export const loadDeadlineSchema = z.object({
  loadMs: deadlineMsSchema.optional()
})

export type RequestDeadline = z.infer<typeof requestDeadlineSchema>
export type CapabilityDeadline = z.infer<typeof capabilityDeadlineSchema>
export type LoadDeadline = z.infer<typeof loadDeadlineSchema>
