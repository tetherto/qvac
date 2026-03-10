import { completion, deleteCache } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { kvCacheTests } from "../../kv-cache-tests.js";

export class KvCacheExecutor extends AbstractModelExecutor<typeof kvCacheTests> {
  pattern = /^kv-cache-/;

  protected handlers = Object.fromEntries(
    kvCacheTests.map((test) => {
      if (test.testId === "kv-cache-delete-and-reuse") return [test.testId, this.deleteAndReuse.bind(this)];
      if (test.testId === "kv-cache-session-switch") return [test.testId, this.sessionSwitch.bind(this)];
      if (test.testId === "kv-cache-different-system-prompts") return [test.testId, this.differentSystemPrompts.bind(this)];
      if (test.testId === "kv-cache-stats-verification") return [test.testId, this.statsVerification.bind(this)];
      if (test.testId.startsWith("kv-cache-delete-") || test.testId === "kv-cache-hypercore-deletion") {
        return [test.testId, this.deleteCacheOp.bind(this)];
      }
      return [test.testId, this.kvCompletion.bind(this)];
    }),
  ) as never;

  async deleteCacheOp(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { deleteAll?: boolean; kvCacheKey?: string; modelIdToDelete?: string };

    try {
      let result: { success: boolean };
      if (p.deleteAll) {
        result = await deleteCache({ all: true });
      } else if (p.kvCacheKey) {
        const opts: { kvCacheKey: string; modelId?: string } = { kvCacheKey: p.kvCacheKey };
        if (p.modelIdToDelete) opts.modelId = p.modelIdToDelete;
        result = await deleteCache(opts);
      } else {
        return { passed: false, output: "No delete params provided" };
      }
      return ValidationHelpers.validate(
        result.success ? "success" : "failed",
        expectation as Expectation,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Delete cache failed: ${errorMsg}` };
    }
  }

  private async runCompletion(modelId: string, params: {
    history: Array<{ role: string; content: string }>;
    stream?: boolean;
    kvCache?: string | boolean;
    tools?: unknown[];
  }): Promise<string> {
    const result = completion({
      modelId,
      history: params.history,
      stream: params.stream ?? false,
      kvCache: params.kvCache as never,
      ...(params.tools ? { tools: params.tools as never } : {}),
    });

    if (params.stream) {
      let fullText = "";
      for await (const token of result.tokenStream) {
        fullText += token;
      }
      return fullText;
    }
    return result.text;
  }

  async kvCompletion(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string }>;
      stream?: boolean;
      kvCache?: string | boolean;
      tools?: unknown[];
    };
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      const text = await this.runCompletion(modelId, p);
      return ValidationHelpers.validate(text, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `KV cache completion failed: ${errorMsg}` };
    }
  }

  async sessionSwitch(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      sessions: Array<{ key: string; message: string }>;
      stream: boolean;
    };
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      const responses: string[] = [];
      for (const session of p.sessions) {
        const text = await this.runCompletion(modelId, {
          history: [
            { role: "system", content: "You are a helpful math assistant. Be brief." },
            { role: "user", content: session.message },
          ],
          stream: p.stream,
          kvCache: session.key,
        });
        responses.push(text);
      }

      const allResponded = responses.every((r) => r.length > 0);
      const result = `Session switching: ${responses.length} responses, all valid: ${allResponded}`;
      return ValidationHelpers.validate(result, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Session switch failed: ${errorMsg}` };
    }
  }

  async differentSystemPrompts(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      cacheKey: string;
      systemPrompts: string[];
      userMessage: string;
      stream: boolean;
    };
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      const responses: string[] = [];
      for (const systemPrompt of p.systemPrompts) {
        const text = await this.runCompletion(modelId, {
          history: [
            { role: "system", content: systemPrompt },
            { role: "user", content: p.userMessage },
          ],
          stream: p.stream,
          kvCache: p.cacheKey,
        });
        responses.push(text);
      }

      const allResponded = responses.every((r) => r.length > 0);
      const result = `Different system prompts: ${responses.length} responses, all valid: ${allResponded}`;
      return ValidationHelpers.validate(result, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `System prompt test failed: ${errorMsg}` };
    }
  }

  async deleteAndReuse(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      cacheKey: string;
      history: Array<{ role: string; content: string }>;
      stream: boolean;
    };
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      try { await deleteCache({ kvCacheKey: p.cacheKey }); } catch { /* ignore */ }

      const text1 = await this.runCompletion(modelId, {
        history: p.history,
        stream: p.stream,
        kvCache: p.cacheKey,
      });

      await deleteCache({ kvCacheKey: p.cacheKey });

      const text2 = await this.runCompletion(modelId, {
        history: p.history,
        stream: p.stream,
        kvCache: p.cacheKey,
      });

      const result = `Delete and reuse: both calls successful (${text1.length} + ${text2.length} chars)`;
      return ValidationHelpers.validate(result, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Delete and reuse failed: ${errorMsg}` };
    }
  }

  async statsVerification(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      cacheKey: string;
      messages: string[];
      stream: boolean;
    };
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      try { await deleteCache({ kvCacheKey: p.cacheKey }); } catch { /* ignore */ }

      const history: Array<{ role: string; content: string }> = [
        { role: "system", content: "You are a helpful assistant. Be brief." },
      ];

      let firstCacheTokens = 0;
      let secondCacheTokens = 0;

      for (let i = 0; i < p.messages.length; i++) {
        history.push({ role: "user", content: p.messages[i]! });

        const result = completion({
          modelId,
          history: [...history],
          stream: true,
          kvCache: p.cacheKey,
        });

        let response = "";
        for await (const token of result.tokenStream) {
          response += token;
        }

        const stats = await result.stats;
        const cacheTokens = (stats as Record<string, unknown>)?.cacheTokens as number ?? 0;

        if (i === 0) firstCacheTokens = cacheTokens;
        else secondCacheTokens = cacheTokens;

        history.push({ role: "assistant", content: response });
      }

      const cacheUsed = secondCacheTokens > firstCacheTokens || secondCacheTokens > 0;
      const result = `Cache tokens: first=${firstCacheTokens}, second=${secondCacheTokens}, used: ${cacheUsed}`;
      return ValidationHelpers.validate(result, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Stats verification failed: ${errorMsg}` };
    }
  }
}
