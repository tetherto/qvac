export type NumericLike = `${number}`;
export type AddonOutputCallback = (addon: unknown, event: string, data: unknown, error?: Error) => void;
/**
 * Validates the single disk path. For a sharded GGUF, pass only the first
 * shard; Fabric discovers the remaining shards. Weight streaming is unsupported.
 */
export declare function validateModelPath(files: string[]): string;
