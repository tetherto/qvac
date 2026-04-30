import { completion } from "@qvac/sdk";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { visionTests } from "../../vision-tests.js";

type VisionParams = {
  history: Array<{ role: string; content: string; attachments?: Array<{ path: string }> }>;
  stream?: boolean;
};

export class VisionExecutor extends AbstractModelExecutor<typeof visionTests> {
  pattern = /^vision-/;

  protected handlers = Object.fromEntries(
    visionTests.map((test) => {
      if (test.testId.endsWith("-streaming")) {
        return [test.testId, this.streaming.bind(this)];
      }
      if (test.testId.endsWith("-stats")) {
        return [test.testId, this.withStats.bind(this)];
      }
      return [test.testId, this.generic.bind(this)];
    }),
  ) as never;

  private resolveAttachments(
    history: VisionParams["history"],
  ) {
    return history.map((msg) => {
      if (!msg.attachments?.length) return msg;
      return {
        ...msg,
        attachments: msg.attachments.map((att) => {
          const fileName = att.path.split("/").pop()!;
          return { path: path.resolve(process.cwd(), "assets/images", fileName) };
        }),
      };
    });
  }

  async generic(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as VisionParams;
    const visionModelId = await this.resources.ensureLoaded("vision");
    const history = this.resolveAttachments(p.history);

    try {
      const result = completion({
        modelId: visionModelId,
        history,
        stream: false,
      });

      const text = await result.text;
      return ValidationHelpers.validate(text, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (expectation.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, expectation);
      }
      return { passed: false, output: `Vision failed: ${errorMsg}` };
    }
  }

  async streaming(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as VisionParams;
    const visionModelId = await this.resources.ensureLoaded("vision");
    const history = this.resolveAttachments(p.history);

    try {
      const result = completion({
        modelId: visionModelId,
        history,
        stream: true,
      });

      const tokens: string[] = [];
      for await (const token of result.tokenStream) {
        tokens.push(token);
      }

      if (tokens.length === 0) {
        return { passed: false, output: "Streaming produced zero tokens" };
      }

      const text = tokens.join("");
      const validation = ValidationHelpers.validate(text, expectation);
      return {
        ...validation,
        output: `${validation.output} (streamed ${tokens.length} tokens)`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Vision streaming failed: ${errorMsg}` };
    }
  }

  async withStats(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as VisionParams;
    const visionModelId = await this.resources.ensureLoaded("vision");
    const history = this.resolveAttachments(p.history);

    try {
      const result = completion({
        modelId: visionModelId,
        history,
        stream: false,
      });

      const text = await result.text;
      const stats = await result.stats;

      const textValidation = ValidationHelpers.validate(text, expectation);
      if (!textValidation.passed) return textValidation;

      if (!stats) {
        return { passed: false, output: `Vision OK but stats were undefined. Text: "${text}"` };
      }
      if (typeof stats.timeToFirstToken !== "number" || typeof stats.tokensPerSecond !== "number") {
        return { passed: false, output: `Stats missing fields. Got: ${JSON.stringify(stats)}` };
      }

      return {
        passed: true,
        output: `Text: "${text}", ttft: ${stats.timeToFirstToken}ms, tps: ${stats.tokensPerSecond}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Vision stats failed: ${errorMsg}` };
    }
  }
}
