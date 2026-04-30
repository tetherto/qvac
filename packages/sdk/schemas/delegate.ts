import { z } from "zod";

const HYPERSWARM_PUBLIC_KEY_HEX = /^[0-9a-fA-F]{64}$/;

export const delegateBaseSchema = z.object({
  providerPublicKey: z
    .string()
    .regex(
      HYPERSWARM_PUBLIC_KEY_HEX,
      "providerPublicKey must be a 64-character hex string (32-byte ed25519 public key)",
    )
    .describe("Hex-encoded public key of the remote provider to delegate to."),
  timeout: z
    .number()
    .min(100)
    .optional()
    .describe("Per-call timeout in milliseconds for the delegated request."),
  healthCheckTimeout: z
    .number()
    .min(100)
    .optional()
    .describe(
      "Timeout in milliseconds for the health-check probe before delegating.",
    ),
});

export const delegateSchema = delegateBaseSchema
  .extend({
    fallbackToLocal: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "When `true`, fall back to local execution if the delegated provider is unreachable.",
      ),
    forceNewConnection: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "When `true`, skip any cached delegation connection and open a fresh one.",
      ),
  })
  .optional();

export type DelegateBase = z.infer<typeof delegateBaseSchema>;
export type Delegate = z.infer<typeof delegateSchema>;
