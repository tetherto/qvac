import {
  detectShardedModel,
  generateShardFilenames,
} from "@/utils/shard-pattern";

/** Expand a sharded GGUF path to its `.tensors.txt` companion followed by each shard; non-sharded paths pass through. */
export function expandGGUFIntoShards(modelPath: string): string[] {
  const lastSep = Math.max(modelPath.lastIndexOf("/"), modelPath.lastIndexOf("\\"));
  const dir = lastSep >= 0 ? modelPath.slice(0, lastSep) : "";
  const sep = lastSep >= 0 ? modelPath.charAt(lastSep) : "";
  const filename = lastSep >= 0 ? modelPath.slice(lastSep + 1) : modelPath;

  const info = detectShardedModel(filename);
  if (!info.isSharded || !info.baseFilename) return [modelPath];

  const join = (name: string) => (dir ? `${dir}${sep}${name}` : name);
  return [
    join(`${info.baseFilename}.tensors.txt`),
    ...generateShardFilenames(filename).map(join),
  ];
}
