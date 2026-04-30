import { transcribe } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { parakeetTests } from "../../parakeet-tests.js";

export class MobileParakeetExecutor extends ModelAssetExecutor<
  typeof parakeetTests
> {
  pattern = /^parakeet-/;
  protected handlers = Object.fromEntries(
    parakeetTests.map((test) => [
      test.testId,
      (params: unknown, expectation: unknown) =>
        this.runTest(test.testId, params, expectation),
    ]),
  ) as never;
  protected defaultHandler = undefined;

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

  async runTest(
    testId: string,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const p = params as { audioFileName: string };
    const exp = expectation as Expectation;

    const resourceKey = this.resolveResource(testId);
    const modelId = await this.resources.ensureLoaded(resourceKey);

    const audio = await this.loadAudioAssets();
    const assetModule = audio[p.audioFileName];
    if (!assetModule) {
      return { passed: false, output: `Audio file not found: ${p.audioFileName}` };
    }

    try {
      const audioUri = await this.resolveAsset(assetModule);
      const text = await transcribe({
        modelId,
        audioChunk: audioUri,
      });
      const trimmedText = text.trim();

      if (exp.validation === "throws-error") {
        return { passed: false, output: "Expected error but transcription succeeded" };
      }
      return ValidationHelpers.validate(trimmedText, exp);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (exp.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, exp);
      }
      return { passed: false, output: `Parakeet transcription failed: ${errorMsg}` };
    }
  }

  private resolveResource(testId: string): string {
    if (testId.startsWith("parakeet-ctc-")) return "parakeet-ctc";
    if (testId.startsWith("parakeet-sortformer-")) return "parakeet-sortformer";
    return "parakeet-tdt";
  }
}
