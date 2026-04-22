import { DiffusionExecutor as SharedDiffusionExecutor } from "../../shared/executors/diffusion-executor.js";

export class MobileDiffusionExecutor extends SharedDiffusionExecutor {
  private imageAssets: Record<string, number> | null = null;

  private async loadImageAssets() {
    if (!this.imageAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.imageAssets = assets.images;
    }
    return this.imageAssets!;
  }

  private async resolveAssetBytes(assetModule: number): Promise<Uint8Array> {
    // @ts-ignore - expo-asset is a peer dependency available in mobile context
    const { Asset } = await import("expo-asset");
    const asset = Asset.fromModule(assetModule);
    asset.downloaded = false;
    await asset.downloadAsync();
    const uri: string = asset.localUri || asset.uri;
    if (!uri) {
      throw new Error(`Failed to resolve asset: ${asset.name ?? "unknown"}`);
    }
    const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;
    // @ts-ignore - expo-file-system is a peer dependency available in mobile context
    const { File } = await import("expo-file-system");
    return await new File(fileUri).bytes();
  }

  protected override async resolveParams(
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof p.init_image !== "string") return p;

    const fileName = p.init_image.split("/").pop()!;
    const images = await this.loadImageAssets();
    const assetModule = images[fileName];
    if (!assetModule) {
      throw new Error(`Image file not found in assets: ${fileName}`);
    }
    const bytes = await this.resolveAssetBytes(assetModule);
    return { ...p, init_image: bytes };
  }
}
