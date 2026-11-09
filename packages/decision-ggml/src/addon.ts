// eslint-disable-next-line @typescript-eslint/no-require-imports -- bare-path uses CommonJS.
import path = require("bare-path");

export type NumericLike = `${number}`;

export type AddonOutputCallback = (
  addon: unknown,
  event: string,
  data: unknown,
  error?: Error,
) => void;

/**
 * Validates the single disk path. For a sharded GGUF, pass only the first
 * shard; Fabric discovers the remaining shards. Weight streaming is unsupported.
 */
export function validateModelPath(files: string[]): string {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError("files.model must contain one absolute disk path");
  }
  if (files.length !== 1) {
    throw new TypeError(
      "Weight streaming is no longer supported. Pass only one disk path in files.model; " +
        "for a sharded model, pass only the first shard path. Do not pass a tensor-name file.",
    );
  }
  if (typeof files[0] !== "string" || files[0].length === 0 || !path.isAbsolute(files[0])) {
    throw new TypeError("files.model[0] must be an absolute disk path string; weight buffers are not supported");
  }
  if (files[0].endsWith(".tensors.txt")) {
    throw new TypeError("Weight streaming is no longer supported. Pass the first GGUF shard path, not a tensor-name file.");
  }
  return files[0];
}
