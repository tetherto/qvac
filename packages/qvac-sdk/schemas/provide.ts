import { z } from "zod";

export const firewallConfigSchema = z.object({
  mode: z.enum(["allow", "deny"]).default("allow"),
  publicKeys: z.array(z.string()).default([]),
});

export const provideParamsSchema = z
  .object({
    topic: z.string(),
    firewall: firewallConfigSchema.optional(),
  })
  .strict();

export const provideRequestSchema = provideParamsSchema.extend({
  type: z.literal("provide"),
  topic: z.string(),
  firewall: firewallConfigSchema.optional(),
});

export const provideResponseSchema = z.object({
  type: z.literal("provide"),
  success: z.boolean(),
  error: z.string().optional(),
  publicKey: z.string().optional(),
});

export const envSchema = z.object({
  QVAC_HYPERSWARM_SEED: z.string(),
});

export type FirewallConfig = z.infer<typeof firewallConfigSchema>;
export type ProvideParams = z.infer<typeof provideParamsSchema>;
export type ProvideRequest = z.infer<typeof provideRequestSchema>;
export type ProvideResponse = z.infer<typeof provideResponseSchema>;
