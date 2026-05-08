/**
 * Resolve a bundled RN asset module to a real filesystem path.
 *
 * On Android release builds expo-asset pre-sets `downloaded=true` and
 * `localUri` to a drawable resource name (e.g. `assets_images_cat`),
 * bypassing the native downloadAsync() that copies the resource to a
 * cache file. Resetting `downloaded=false` forces the native module to
 * run and produce a real `file://` URI — which we strip + percent-decode
 * because SDK native addons (whisper, FFmpeg, ONNX runtime) expect POSIX
 * paths, not URIs.
 */
export async function resolveBundledAssetUri(assetModule: number): Promise<string> {
  // @ts-ignore - expo-asset is a peer dependency available in mobile context
  const { Asset } = await import("expo-asset");
  const asset = Asset.fromModule(assetModule);
  asset.downloaded = false;
  await asset.downloadAsync();
  const rawUri: string | undefined = asset.localUri ?? asset.uri;
  if (!rawUri) {
    throw new Error(`Failed to resolve asset: ${asset.name ?? "unknown"}`);
  }
  return decodeURIComponent(rawUri.replace(/^file:\/\//, ""));
}
