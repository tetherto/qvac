const SHARD_PATTERN = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/;

/** Expand a sharded GGUF path into `.tensors.txt` plus all shards. */
export function expandGGUFIntoShards(modelPath: string): string[] {
  const lastSep = Math.max(
    modelPath.lastIndexOf("/"),
    modelPath.lastIndexOf("\\"),
  );
  const dir = lastSep >= 0 ? modelPath.slice(0, lastSep) : "";
  const sep = lastSep >= 0 ? modelPath.charAt(lastSep) : "/";
  const filename = lastSep >= 0 ? modelPath.slice(lastSep + 1) : modelPath;

  const match = filename.match(SHARD_PATTERN);
  if (!match || !match[1] || !match[3]) return [modelPath];

  const baseFilename = match[1];
  const totalDigits = match[3];
  const totalShards = Number.parseInt(totalDigits, 10);
  if (totalShards <= 0) return [modelPath];

  const join = (name: string) => (dir ? `${dir}${sep}${name}` : name);
  const shards = [join(`${baseFilename}.tensors.txt`)];

  for (let i = 1; i <= totalShards; i++) {
    shards.push(
      join(
        `${baseFilename}-${String(i).padStart(5, "0")}-of-${totalDigits}.gguf`,
      ),
    );
  }

  return shards;
}
