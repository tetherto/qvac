import { classify } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { classificationTests } from "../../classification-tests.js";

interface ClassificationParams {
  topK?: number;
  inputs?: "invalid";
}

const SAMPLE_IMAGE_FILENAME = "elephant.jpg";

export class MobileClassificationExecutor extends ModelAssetExecutor<
  typeof classificationTests
> {
  pattern = /^classification-/;

  protected handlers = Object.fromEntries(
    classificationTests.map((test) => {
      switch (test.testId) {
        case "classification-invalid-image":
          return [test.testId, this.runInvalidImage.bind(this)];
        default:
          return [test.testId, this.runClassify.bind(this)];
      }
    }),
  ) as never;
  protected defaultHandler = undefined;

  private imageAssets: Record<string, number> | null = null;

  constructor(resources: ResourceManager) {
    super(resources);
  }

  private async loadImageAssets() {
    if (!this.imageAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.imageAssets = assets.images;
    }
    return this.imageAssets!;
  }

  // Mirrors MobileDiffusionExecutor's resolveAssetBytes — expo-file-system's
  // `File.bytes()` returns a Uint8Array we can pass straight to `classify()`.
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

  private async readSampleImage(): Promise<Uint8Array> {
    const images = await this.loadImageAssets();
    const assetModule = images[SAMPLE_IMAGE_FILENAME];
    if (!assetModule) {
      throw new Error(
        `Image file not found in bundled assets: ${SAMPLE_IMAGE_FILENAME}`,
      );
    }
    return await this.resolveAssetBytes(assetModule);
  }

  async runClassify(
    params: ClassificationParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    try {
      const modelId = await this.resources.ensureLoaded("classification");
      const image = await this.readSampleImage();
      const results = await classify({
        modelId,
        image,
        ...(params.topK !== undefined && { topK: params.topK }),
      });
      return ValidationHelpers.validate({ results }, expectation);
    } catch (error) {
      return {
        passed: false,
        output: `classify failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async runInvalidImage(
    _params: ClassificationParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    try {
      const modelId = await this.resources.ensureLoaded("classification");
      const badImage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      let rejected = false;
      let errorMsg = "";
      try {
        await classify({ modelId, image: badImage });
      } catch (e) {
        rejected = true;
        errorMsg = e instanceof Error ? e.message : String(e);
      }

      let recoveryRan = false;
      try {
        const goodResults = await classify({
          modelId,
          image: await this.readSampleImage(),
        });
        recoveryRan = Array.isArray(goodResults) && goodResults.length > 0;
      } catch {
        recoveryRan = false;
      }

      return ValidationHelpers.validate(
        { rejected, recoveryRan, errorMsg },
        expectation,
      );
    } catch (error) {
      return {
        passed: false,
        output: `classification invalid-image test failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
