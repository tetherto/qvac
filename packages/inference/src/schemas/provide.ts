import { z } from 'zod'

export const firewallConfigSchema = z.object({
  mode: z.enum(['allow', 'deny']).default('allow'),
  publicKeys: z.array(z.string()).default([])
})

export const provideParamsSchema = z
  .object({
    firewall: firewallConfigSchema.optional()
  })
  .strict()

export const provideRequestSchema = provideParamsSchema.extend({
  type: z.literal('provide')
})

export const provideResponseSchema = z.object({
  type: z.literal('provide'),
  success: z.boolean(),
  error: z.string().optional(),
  publicKey: z.string().optional()
})

export const envSchema = z.object({
  QVAC_HYPERSWARM_SEED: z.string()
})

export const stopProvideRequestSchema = z
  .object({
    type: z.literal('stopProvide')
  })
  .strict()

export const stopProvideResponseSchema = z.object({
  type: z.literal('stopProvide'),
  success: z.boolean(),
  error: z.string().optional()
})

export type FirewallConfig = z.infer<typeof firewallConfigSchema>
export type ProvideParams = z.infer<typeof provideParamsSchema>
export type ProvideRequest = z.infer<typeof provideRequestSchema>
export type ProvideResponse = z.infer<typeof provideResponseSchema>
export type StopProvideRequest = z.infer<typeof stopProvideRequestSchema>
export type StopProvideResponse = z.infer<typeof stopProvideResponseSchema>
