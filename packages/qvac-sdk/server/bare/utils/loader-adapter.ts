import type FilesystemDL from "@qvac/dl-filesystem";

/**
 * Adapts FilesystemDL to addon Loader interface by adding download stub.
 * download() is never called when using filesystem loader.
 */
export function asLoader<T>(loader: FilesystemDL): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (loader as any).download = () =>
    Promise.reject(new Error("download not supported"));
  return loader as unknown as T;
}
