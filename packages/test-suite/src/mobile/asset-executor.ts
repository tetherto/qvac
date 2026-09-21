// @ts-ignore - expo-asset is a peer dependency
import { Asset } from 'expo-asset'
import { BaseExecutor, type TestDefinitions } from '../core/base-executor.js'

/**
 * Executor for mobile tests that require Expo Assets (audio, images, documents, etc.)
 * Provides asset resolution from require() modules to file URIs
 */
export abstract class AssetExecutor<TDefs extends TestDefinitions> extends BaseExecutor<TDefs> {
  /**
   * Resolve an Expo Asset from require() module to local file URI
   * Works for any asset type: audio, images, documents, etc.
   *
   * @param assetModule - Asset module from require() (e.g., audio['file.mp3'])
   * @returns Local file URI usable by native APIs
   */
  protected async resolveAsset(assetModule: number): Promise<string> {
    const asset = Asset.fromModule(assetModule)

    if (!asset.localUri) {
      await asset.downloadAsync()
    }

    if (!asset.localUri) {
      throw new Error(`Failed to resolve asset: ${asset.name || 'unknown'}`)
    }

    // Strip file:// prefix for native code access
    const uri = asset.localUri
    const path = uri.startsWith('file://') ? uri.substring(7) : uri
    return path
  }
}
