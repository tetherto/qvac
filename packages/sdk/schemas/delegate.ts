import { z } from "zod";

const HYPERSWARM_PUBLIC_KEY_HEX = /^[0-9a-fA-F]{64}$/;

export const delegateBaseSchema = z.object({
  providerPublicKey: z
    .string()
    .regex(
      HYPERSWARM_PUBLIC_KEY_HEX,
      "providerPublicKey must be a 64-character hex string (32-byte ed25519 public key)",
    ),
  timeout: z.number().min(100).optional(),
  healthCheckTimeout: z.number().min(100).optional(),
});

export const delegateSchema = delegateBaseSchema
  .extend({
    fallbackToLocal: z.boolean().optional().default(false),
    forceNewConnection: z.boolean().optional().default(false),
  })
  .optional();

export type DelegateBase = z.infer<typeof delegateBaseSchema>;
export type Delegate = z.infer<typeof delegateSchema>;
