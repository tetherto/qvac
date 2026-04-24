import { z } from "zod";

export const getLoadedModelInfoParamsSchema = z.object({
  modelId: z.string(),
});

export const getLoadedModelInfoRequestSchema =
  getLoadedModelInfoParamsSchema.extend({
    type: z.literal("getLoadedModelInfo"),
  });

const delegatedProviderInfoSchema = z.object({
  topic: z.string(),
  providerPublicKey: z.string(),
});

/**
 * Loaded local model: routing plugin known on this node, so modelType +
 * handler vocabulary are authoritative.
 */
const localLoadedModelInfoSchema = z.object({
  modelId: z.string(),
  isDelegated: z.literal(false),
  modelType: z.string(),
  handlers: z.array(z.string()),
  displayName: z.string().optional(),
  addonPackage: z.string().optional(),
  loadedAt: z.coerce.date(),
  name: z.string().optional(),
  path: z.string().optional(),
});

/**
 * Loaded delegated model: this node only stores routing info, so `modelType`,
 * `displayName`, `addonPackage`, `loadedAt`, `name`, and `path` are absent,
 * and `handlers` is always empty.
 */
const delegatedLoadedModelInfoSchema = z.object({
  modelId: z.string(),
  isDelegated: z.literal(true),
  handlers: z.array(z.string()),
  providerInfo: delegatedProviderInfoSchema,
});

export const loadedModelInfoSchema = z.discriminatedUnion("isDelegated", [
  localLoadedModelInfoSchema,
  delegatedLoadedModelInfoSchema,
]);

export const getLoadedModelInfoResponseSchema = z.object({
  type: z.literal("getLoadedModelInfo"),
  info: loadedModelInfoSchema,
});

export type GetLoadedModelInfoParams = z.input<
  typeof getLoadedModelInfoParamsSchema
>;
export type GetLoadedModelInfoRequest = z.infer<
  typeof getLoadedModelInfoRequestSchema
>;
export type GetLoadedModelInfoResponse = z.infer<
  typeof getLoadedModelInfoResponseSchema
>;
export type LoadedModelInfo = z.infer<typeof loadedModelInfoSchema>;
