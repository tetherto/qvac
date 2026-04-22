export function resolveClearStorageTarget(
  modelPath: string,
  modelsCacheDir: string,
): { path: string; kind: "file" | "directory" } {
  const normalizedCache = modelsCacheDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = modelPath.replace(/\\/g, "/");

  if (!normalizedPath.startsWith(`${normalizedCache}/`)) {
    return { path: modelPath, kind: "file" };
  }

  const relativePath = normalizedPath.slice(normalizedCache.length + 1);
  const parts = relativePath.split("/");

  if (
    parts.length === 3 &&
    (parts[0] === "sets" || parts[0] === "onnx") &&
    parts[1] &&
    parts[2]
  ) {
    const lastSlash = normalizedPath.lastIndexOf("/");
    return { path: normalizedPath.slice(0, lastSlash), kind: "directory" };
  }

  return { path: modelPath, kind: "file" };
}

