import fs from "node:fs";
import path from "node:path";
import { classify } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { classificationTests } from "../../classification-tests.js";

interface ClassificationParams {
  topK?: number;
  inputs?: "invalid";
}

const SAMPLE_IMAGE_PATH = path.resolve(
  process.cwd(),
  "assets/images/elephant.jpg",
);

export class ClassificationExecutor extends AbstractModelExecutor<
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

  private async ensureModel() {
    return this.resources.ensureLoaded("classification");
  }

  private readSampleImage(): Uint8Array {
    return new Uint8Array(fs.readFileSync(SAMPLE_IMAGE_PATH));
  }

  async runClassify(
    params: ClassificationParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureModel();
      const image = this.readSampleImage();
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
      const modelId = await this.ensureModel();
      // 4 bytes is too small to decode as JPEG/PNG — addon should reject.
      const badImage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      let rejected = false;
      let errorMsg = "";
      try {
        await classify({ modelId, image: badImage });
      } catch (e) {
        rejected = true;
        errorMsg = e instanceof Error ? e.message : String(e);
      }

      // After the rejection, a fresh valid classify() must succeed —
      // proves the addon does not wedge on the error path.
      let recoveryRan = false;
      try {
        const goodResults = await classify({
          modelId,
          image: this.readSampleImage(),
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
