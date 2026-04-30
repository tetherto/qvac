import { AssetExecutor, type TestDefinitions } from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { modelSetup, modelTeardown } from "../../shared/resource-lifecycle.js";

/**
 * Combines AssetExecutor's resolveAsset() with the shared model
 * resource lifecycle (download, evict, load/unload).
 */
export abstract class ModelAssetExecutor<
  TDefs extends TestDefinitions,
> extends AssetExecutor<TDefs> {
  constructor(protected resources: ResourceManager) {
    super();
  }

  /**
   * On Android release builds, images are bundled as drawable resources.
   * expo-asset pre-sets downloaded=true and localUri to the drawable resource
   * name (e.g. "assets_images_cat"), bypassing the native downloadAsync()
   * that would copy the resource to a real cache file. Resetting downloaded=false
   * forces the native module to run, which uses Android's ResourceManager to
   * copy the drawable to the ExponentAsset cache and returns a real file:// URI.
   */
  protected override async resolveAsset(assetModule: number): Promise<string> {
    // @ts-ignore - expo-asset is a peer dependency available in mobile context
    const { Asset } = await import("expo-asset");
    const asset = Asset.fromModule(assetModule);
    asset.downloaded = false;
    await asset.downloadAsync();
    let uri: string = asset.localUri || asset.uri;
    if (!uri) {
      throw new Error(`Failed to resolve asset: ${asset.name ?? "unknown"}`);
    }
    if (uri.startsWith("file://")) {
      uri = uri.substring(7);
    }
    return decodeURIComponent(uri);
  }

  async setup(testId: string, context: unknown) {
    await modelSetup(this.resources, context);
  }

  async teardown(testId: string, context: unknown) {
    await modelTeardown(this.resources);
  }
}
