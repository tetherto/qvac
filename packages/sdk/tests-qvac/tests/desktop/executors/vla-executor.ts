import {
  vla,
  vlaHparams,
  vlaPadState,
  vlaPreprocessImage,
} from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { vlaTests } from "../../vla-tests.js";

interface VlaParams {
  inputs?: "synthetic" | "synthetic-wrong-img-size";
}

interface HparamsShape {
  chunkSize: number;
  actionDim: number;
  maxActionDim: number;
  maxStateDim: number;
  tokenizerMaxLength: number;
  visionImageSize: number;
}

export class VlaExecutor extends AbstractModelExecutor<typeof vlaTests> {
  pattern = /^vla-/;

  protected handlers = Object.fromEntries(
    vlaTests.map((test) => {
      switch (test.testId) {
        case "vla-hparams-shape":
          return [test.testId, this.runHparams.bind(this)];
        case "vla-invalid-img-size":
          return [test.testId, this.runInvalidImgSize.bind(this)];
        default:
          return [test.testId, this.runSyntheticInference.bind(this)];
      }
    }),
  ) as never;

  private async ensureModel() {
    return this.resources.ensureLoaded("vla");
  }

  private buildSyntheticInputs(hp: HparamsShape) {
    const size = hp.visionImageSize;
    const dummyPixels = new Uint8Array(size * size * 3).fill(128);
    const front = vlaPreprocessImage(dummyPixels, size, size, { size });
    const wrist = vlaPreprocessImage(dummyPixels, size, size, { size });
    const tokens = new Int32Array(hp.tokenizerMaxLength);
    const mask = new Uint8Array(hp.tokenizerMaxLength);
    // BOS-only "instruction" — exercises the full prefill path without
    // depending on a tokenizer at test time.
    tokens[0] = 1;
    mask[0] = 1;
    const state = vlaPadState([0, 0, 0, 0, 0, 0], hp.maxStateDim);
    const noise = new Float32Array(hp.chunkSize * hp.maxActionDim);
    return {
      images: [front, wrist],
      imgWidth: size,
      imgHeight: size,
      state,
      tokens,
      mask,
      noise,
    };
  }

  async runHparams(_params: VlaParams, expectation: Expectation): Promise<TestResult> {
    try {
      const modelId = await this.ensureModel();
      const result = await vlaHparams({ modelId });
      return ValidationHelpers.validate(result, expectation);
    } catch (error) {
      return {
        passed: false,
        output: `vlaHparams failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async runSyntheticInference(
    _params: VlaParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureModel();
      const { hparams } = await vlaHparams({ modelId });
      const inputs = this.buildSyntheticInputs(hparams);
      const { actions, actionDim, chunkSize, stats } = await vla({
        modelId,
        ...inputs,
      });
      // Surface a flat result shape to the test's `fn` so the assertions
      // in vla-tests.ts can stay framework-agnostic.
      return ValidationHelpers.validate(
        {
          actionsLength: actions.length,
          expectedLength: chunkSize * actionDim,
          actionDim,
          chunkSize,
          stats,
        },
        expectation,
      );
    } catch (error) {
      return {
        passed: false,
        output: `vla inference failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async runInvalidImgSize(
    _params: VlaParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureModel();
      const { hparams } = await vlaHparams({ modelId });
      const size = hparams.visionImageSize;
      const wrongSize = size === 256 ? 512 : 256;

      // Build inputs whose pixel buffers ARE consistent with the (wrong)
      // imgWidth/imgHeight so we don't trip the earlier
      // "pixel.length === 3*imgW*imgH" check. Only imgWidth !=
      // hparams.visionImageSize is wrong here.
      const dummyPixels = new Float32Array(3 * wrongSize * wrongSize);
      const tokens = new Int32Array(hparams.tokenizerMaxLength);
      const mask = new Uint8Array(hparams.tokenizerMaxLength);
      tokens[0] = 1;
      mask[0] = 1;
      const state = vlaPadState([0, 0, 0, 0, 0, 0], hparams.maxStateDim);
      const badInputs = {
        images: [dummyPixels, dummyPixels],
        imgWidth: wrongSize,
        imgHeight: wrongSize,
        state,
        tokens,
        mask,
      };

      let rejected = false;
      let errorMsg = "";
      try {
        await vla({ modelId, ...badInputs });
      } catch (e) {
        rejected = true;
        errorMsg = e instanceof Error ? e.message : String(e);
      }

      // After the rejection, a fresh canonical-shape run() must succeed —
      // proves `_hasActiveResponse` was cleared (no wedge from QVAC-VLA
      // PR #1784 review). Mirrors the addon's own integration assertion.
      let recoveryRan = false;
      try {
        const inputs = this.buildSyntheticInputs(hparams);
        const { actions } = await vla({ modelId, ...inputs });
        recoveryRan = actions.length === hparams.chunkSize * hparams.actionDim;
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
        output: `vla invalid-img-size test failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
