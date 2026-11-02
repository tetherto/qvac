/** Names of the entries that carry a value, for "wrong engine" messages. */
export function setOptionNames(
  options: Record<string, string | number | boolean | undefined>,
): string[] {
  return Object.entries(options)
    .filter(([, value]) => value != null)
    .map(([name]) => name);
}

/** Which of `keys` are set on `source`. Used to name stray options in errors. */
export function keysPresent(
  source: object | null | undefined,
  keys: readonly string[],
): string[] {
  if (source == null || typeof source !== "object") return [];
  const record = source as Record<string, unknown>;
  return keys.filter((key) => record[key] != null && record[key] !== "");
}

