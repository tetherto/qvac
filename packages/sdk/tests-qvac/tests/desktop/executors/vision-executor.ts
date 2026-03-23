import { completion } from "@qvac/sdk";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { visionTests } from "../../vision-tests.js";

export class VisionExecutor extends AbstractModelExecutor<typeof visionTests> {
  pattern = /^vision-/;

  protected handlers = Object.fromEntries(
    visionTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  private resolveAttachments(
    history: Array<{ role: string; content: string; attachments?: Array<{ path: string }> }>,
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

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string; attachments?: Array<{ path: string }> }>;
      stream?: boolean;
    };

    const visionModelId = await this.resources.ensureLoaded("vision");
    const history = this.resolveAttachments(p.history);

    try {
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
