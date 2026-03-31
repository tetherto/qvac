import { completion } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { visionTests } from "../../vision-tests.js";

export class MobileVisionExecutor extends ModelAssetExecutor<typeof visionTests> {
  pattern = /^vision-/;

  protected handlers = Object.fromEntries(
    visionTests.map((test) => [test.testId, this.generic.bind(this)]),
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

  private async resolveAttachments(
    history: Array<{ role: string; content: string; attachments?: Array<{ path: string }> }>,
  ) {
    const images = await this.loadImageAssets();
    const resolved = [];

    for (const msg of history) {
      if (!msg.attachments?.length) {
        resolved.push(msg);
        continue;
      }

      const resolvedAttachments = [];
      for (const att of msg.attachments) {
        const fileName = att.path.split("/").pop()!;
        const assetModule = images[fileName];
        if (!assetModule) {
          throw new Error(`Image file not found in assets: ${fileName}`);
        }
        const imageUri = await this.resolveAsset(assetModule);
        resolvedAttachments.push({ path: imageUri });
      }

      resolved.push({ ...msg, attachments: resolvedAttachments });
    }

    return resolved;
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string; attachments?: Array<{ path: string }> }>;
      stream?: boolean;
    };

    const visionModelId = await this.resources.ensureLoaded("vision");

    try {
      const history = await this.resolveAttachments(p.history);

      const result = completion({
        modelId: visionModelId,
        history,
        stream: p.stream ?? false,
      });

      let text: string;
      if (p.stream) {
        text = "";
        for await (const token of result.tokenStream) {
          text += token;
        }
      } else {
        text = await result.text;
      }

      return ValidationHelpers.validate(text, expectation as Expectation);
    } catch (error) {
      const exp = expectation as Expectation;
      if (exp.validation === "throws-error") {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return ValidationHelpers.validate(errorMsg, exp);
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Vision failed: ${errorMsg}` };
    }
  }
}
