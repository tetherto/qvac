import type { TestResult } from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import {
  runParakeetStreamHappy,
  runParakeetStreamMetadataRejected,
  runParakeetStreamEou,
  runParakeetStreamDestroyMidUtterance,
  runParakeetStreamIteratorThrow,
  type ParakeetStreamParams,
} from "../../shared/parakeet-stream-runner.js";
import { parakeetStreamTests } from "../../parakeet-stream-tests.js";

interface BaseParams extends ParakeetStreamParams {
  audioFileName: string;
}

export class MobileParakeetStreamExecutor extends ModelAssetExecutor<
  typeof parakeetStreamTests
> {
  pattern = /^parakeet-stream-/;
  protected handlers = {};
  protected defaultHandler = this.run.bind(this);

  private audioAssets: Record<string, number> | null = null;

  constructor(resources: ResourceManager) {
    super(resources);
  }

  private async loadAudioAssets() {
    if (!this.audioAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.audioAssets = assets.audio;
    }
    return this.audioAssets!;
  }

  private async loadAudioBytes(audioFileName: string): Promise<Uint8Array> {
    const audio = await this.loadAudioAssets();
    const assetModule = audio[audioFileName];
    if (!assetModule) {
      throw new Error(
        `Audio fixture not found in bundled assets: ${audioFileName}`,
      );
    }
    // @ts-ignore - expo-asset is a peer dependency available in mobile context
    const { Asset } = await import("expo-asset");
    const asset = Asset.fromModule(assetModule);
    asset.downloaded = false;
    await asset.downloadAsync();
    const uri: string = asset.localUri || asset.uri;
    if (!uri) {
      throw new Error(`Failed to resolve asset: ${asset.name ?? audioFileName}`);
    }
    const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;
    // @ts-ignore - expo-file-system is a peer dependency available in mobile context
    const { File } = await import("expo-file-system");
    return await new File(fileUri).bytes();
  }

  private async run(testId: string, params: unknown): Promise<TestResult> {
    const p = params as BaseParams;

    if (testId === "parakeet-stream-eou") {
      const modelId = await this.resources.ensureLoaded("parakeet-eou");
      const bytes = await this.loadAudioBytes(p.audioFileName);
      return runParakeetStreamEou(modelId, bytes, p);
    }

    const modelId = await this.resources.ensureLoaded("parakeet-tdt");

    if (testId === "parakeet-stream-metadata-rejected") {
      return runParakeetStreamMetadataRejected(modelId);
    }

    if (testId === "parakeet-stream-destroy-mid-utterance") {
      const bytes = await this.loadAudioBytes(p.audioFileName);
      return runParakeetStreamDestroyMidUtterance(modelId, bytes, p);
    }

    if (testId === "parakeet-stream-iterator-throw") {
      const bytes = await this.loadAudioBytes(p.audioFileName);
      // iOS Device Farm: JSI teardown after destroy() is slower than
      // desktop; recovery opened too soon yields zero text events.
      return runParakeetStreamIteratorThrow(modelId, bytes, {
        ...p,
        postTeardownSettleMs: 2000,
        recoveryMaxAttempts: 4,
      });
    }

    const bytes = await this.loadAudioBytes(p.audioFileName);
    return runParakeetStreamHappy(modelId, bytes, p);
  }
}
