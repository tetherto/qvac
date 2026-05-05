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

  private async resolveImageByName(name: string): Promise<Uint8Array> {
    const fileName = name.split("/").pop()!;
    const images = await this.loadImageAssets();
    const assetModule = images[fileName];
    if (!assetModule) {
      throw new Error(`Image file not found in assets: ${fileName}`);
    }
    return await this.resolveAssetBytes(assetModule);
  }

  protected override async resolveParams(
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { ...p };

    if (p.init_image !== undefined) {
      if (typeof p.init_image !== "string") {
        throw new Error(
          `init_image in test params must be a string filename, got: ${typeof p.init_image}`,
        );
      }
      out.init_image = await this.resolveImageByName(p.init_image);
    }

    if (p.init_images !== undefined) {
      if (
        !Array.isArray(p.init_images) ||
        !p.init_images.every((v) => typeof v === "string")
      ) {
        throw new Error(
          "init_images in test params must be a string[] of image filenames",
        );
      }
      out.init_images = await Promise.all(
        (p.init_images as string[]).map((n) => this.resolveImageByName(n)),
      );
    }

    return out;
  }
}
