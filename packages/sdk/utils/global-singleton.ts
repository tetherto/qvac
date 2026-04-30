export function getGlobalSingleton<T>(key: symbol, create: () => T): T {
  const global = globalThis as { [key: symbol]: unknown };
  const existing = global[key];
  if (existing !== undefined) {
    return existing as T;
  }

  const value = create();
  global[key] = value;
  return value;
}
