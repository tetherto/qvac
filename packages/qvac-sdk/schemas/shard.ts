import { z } from "zod";

export const shardFileMetadataSchema = z.object({
  filename: z.string(),
  expectedSize: z.number(),
  sha256Checksum: z.string(),
});

export const shardUrlSchema = z.object({
  url: z.url(),
  filename: z.string(),
});

export const shardPatternInfoSchema = z.object({
  isSharded: z.boolean(),
  currentShard: z.number().optional(),
  totalShards: z.number().optional(),
  baseFilename: z.string().optional(),
  extension: z.string().optional(),
});

export type ShardFileMetadata = z.infer<typeof shardFileMetadataSchema>;
export type ShardUrl = z.infer<typeof shardUrlSchema>;
export type ShardPatternInfo = z.infer<typeof shardPatternInfoSchema>;
