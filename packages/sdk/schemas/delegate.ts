import { z } from "zod";

export const delegateBaseSchema = z.object({
  topic: z.string(),
  providerPublicKey: z.string(),
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
