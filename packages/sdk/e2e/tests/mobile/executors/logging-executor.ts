import { transcribe, ocr } from "@qvac/sdk";
import { LoggingExecutor } from "../../shared/executors/logging-executor.js";

interface AudioParams { audioFileName: string }
interface ImageParams { imageFileName: string }

interface AssetsModule {
  audio: Record<string, number>;
  images: Record<string, number>;
}

type AssetCategory = keyof AssetsModule;

export class MobileLoggingExecutor extends LoggingExecutor {
  private assets: AssetsModule | null = null;

  protected override triggerWhisper(modelId: string, params: AudioParams): Promise<void> {
    return this.runTranscribe(modelId, params);
  }

  protected override triggerParakeet(modelId: string, params: AudioParams): Promise<void> {
    return this.runTranscribe(modelId, params);
  }

  protected override async triggerOcr(modelId: string, params: ImageParams): Promise<void> {
    const imageUri = await this.resolveAsset("images", params.imageFileName);
    const { blocks } = ocr({ modelId, image: imageUri, stream: false });
    await blocks;
  }

  private async runTranscribe(modelId: string, params: AudioParams): Promise<void> {
    const audioUri = await this.resolveAsset("audio", params.audioFileName);
    await transcribe({ modelId, audioChunk: audioUri });
  }

  private async resolveAsset(category: AssetCategory, filename: string): Promise<string> {
    const assets = await this.loadAssetsModule();
    const assetModule = assets[category][filename];
    if (!assetModule) {
      throw new Error(`Asset not bundled: ${category}/${filename}`);
    }
    return resolveExpoAsset(assetModule);
  }

  private async loadAssetsModule(): Promise<AssetsModule> {
    if (!this.assets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      this.assets = (await import("../../../../assets")) as AssetsModule;
    }
    return this.assets;
  }
}

async function resolveExpoAsset(assetModule: number): Promise<string> {
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
