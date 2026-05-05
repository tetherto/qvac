import { cancel, completion, deleteCache } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { kvCacheTests } from "../../kv-cache-tests.js";

interface ChatMessage {
  role: string;
  content: string;
}

export class KvCacheExecutor extends AbstractModelExecutor<typeof kvCacheTests> {
  pattern = /^kv-cache-/;

  protected handlers = Object.fromEntries(
    kvCacheTests.map((test) => {
      if (test.testId === "kv-cache-delete-and-reuse") return [test.testId, this.deleteAndReuse.bind(this)];
      if (test.testId === "kv-cache-session-switch") return [test.testId, this.sessionSwitch.bind(this)];
      if (test.testId === "kv-cache-different-system-prompts") return [test.testId, this.differentSystemPrompts.bind(this)];
      if (test.testId === "kv-cache-stats-verification") return [test.testId, this.statsVerification.bind(this)];
      if (test.testId === "kv-cache-tools-sequential-save") return [test.testId, this.toolsSequentialSave.bind(this)];
      if (test.testId === "kv-cache-cancel-then-new-prompt") return [test.testId, this.cancelThenNewPrompt.bind(this)];
      if (test.testId.startsWith("kv-cache-delete-") || test.testId === "kv-cache-hypercore-deletion") {
        return [test.testId, this.deleteCacheOp.bind(this)];
      }
      return [test.testId, this.kvCompletion.bind(this)];
    }),
  ) as never;

  async deleteCacheOp(
    params: { deleteAll?: boolean; kvCacheKey?: string; modelIdToDelete?: string },
    expectation: Expectation,
  ): Promise<TestResult> {
    try {
      let result: { success: boolean };
      if (params.deleteAll) {
        result = await deleteCache({ all: true });
      } else if (params.kvCacheKey) {
        const opts: { kvCacheKey: string; modelId?: string } = { kvCacheKey: params.kvCacheKey };
        if (params.modelIdToDelete) opts.modelId = params.modelIdToDelete;
        result = await deleteCache(opts);
      } else {
        return { passed: false, output: "No delete params provided" };
      }
      return ValidationHelpers.validate(result.success ? "success" : "failed", expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Delete cache failed: ${errorMsg}` };
    }
  }

  private async runCompletion(modelId: string, params: {
    history: ChatMessage[];
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

  async kvCompletion(
    params: { history: ChatMessage[]; stream?: boolean; kvCache?: string | boolean; tools?: unknown[] },
    expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      const text = await this.runCompletion(modelId, params);
      return ValidationHelpers.validate(text, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `KV cache completion failed: ${errorMsg}` };
    }
  }

  async sessionSwitch(
    params: { sessions: Array<{ key: string; message: string }>; stream: boolean },
    expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      const responses: string[] = [];
      for (const session of params.sessions) {
        const text = await this.runCompletion(modelId, {
          history: [
            { role: "system", content: "You are a helpful math assistant. Be brief." },
            { role: "user", content: session.message },
          ],
          stream: params.stream,
          kvCache: session.key,
        });
        responses.push(text);
      }

      const allResponded = responses.every((r) => r.length > 0);
      const result = `Session switching: ${responses.length} responses, all valid: ${allResponded}`;
      return ValidationHelpers.validate(result, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Session switch failed: ${errorMsg}` };
    }
  }

  async differentSystemPrompts(
    params: { cacheKey: string; systemPrompts: string[]; userMessage: string; stream: boolean },
    expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      const responses: string[] = [];
      for (const systemPrompt of params.systemPrompts) {
        const text = await this.runCompletion(modelId, {
          history: [
            { role: "system", content: systemPrompt },
            { role: "user", content: params.userMessage },
          ],
          stream: params.stream,
          kvCache: params.cacheKey,
        });
        responses.push(text);
      }

      const allResponded = responses.every((r) => r.length > 0);
      const result = `Different system prompts: ${responses.length} responses, all valid: ${allResponded}`;
      return ValidationHelpers.validate(result, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `System prompt test failed: ${errorMsg}` };
    }
  }

  async deleteAndReuse(
    params: { cacheKey: string; history: ChatMessage[]; stream: boolean },
    expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      try { await deleteCache({ kvCacheKey: params.cacheKey }); } catch { /* ignore */ }

      const text1 = await this.runCompletion(modelId, {
        history: params.history,
        stream: params.stream,
        kvCache: params.cacheKey,
      });

      await deleteCache({ kvCacheKey: params.cacheKey });

      const text2 = await this.runCompletion(modelId, {
        history: params.history,
        stream: params.stream,
        kvCache: params.cacheKey,
      });

      const result = `Delete and reuse: both calls successful (${text1.length} + ${text2.length} chars)`;
      return ValidationHelpers.validate(result, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Delete and reuse failed: ${errorMsg}` };
    }
  }

  async statsVerification(
    params: { cacheKey: string; messages: string[]; stream: boolean },
    expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");

    try {
      try { await deleteCache({ kvCacheKey: params.cacheKey }); } catch { /* ignore */ }

      const history: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant. Be brief." },
      ];

      let firstCacheTokens = 0;
      let secondCacheTokens = 0;

      for (let i = 0; i < params.messages.length; i++) {
        history.push({ role: "user", content: params.messages[i]! });

        const result = completion({
          modelId,
          history: [...history],
          stream: true,
          kvCache: params.cacheKey,
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
      return ValidationHelpers.validate(result, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Stats verification failed: ${errorMsg}` };
    }
  }

  async cancelThenNewPrompt(
    params: {
      cacheKey: string;
      firstUserMessage: string;
      secondUserMessage: string;
      expectedAnswerContains: string;
      cancelAfterTokens?: number;
    },
    _expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");
    const cancelAfterTokens = params.cancelAfterTokens ?? 3;

    try {
      try { await deleteCache({ kvCacheKey: params.cacheKey }); } catch {}

      const firstRun = completion({
        modelId,
        history: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: params.firstUserMessage },
        ],
        stream: true,
        kvCache: params.cacheKey,
      });

      let receivedTokens = 0;
      let cancelInvoked = false;
      let cancelSucceeded = false;
      let cancelError: Error | null = null;

      try {
        for await (const _ of firstRun.tokenStream) {
          receivedTokens++;
          if (!cancelInvoked && receivedTokens >= cancelAfterTokens) {
            cancelInvoked = true;
            try {
              await cancel({ operation: "inference", modelId });
              cancelSucceeded = true;
            } catch (err) {
              cancelError = err instanceof Error ? err : new Error(String(err));
              break;
            }
          }
        }
      } catch (streamErr) {
        if (!cancelInvoked) {
          const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          return {
            passed: false,
            output:
              `First completion stream rejected before cancel could be issued ` +
              `(received ${receivedTokens} tokens): ${msg}`,
          };
        }
      }

      if (cancelError !== null) {
        return {
          passed: false,
          output:
            `cancel() rejected mid-stream after ${receivedTokens} tokens, so the ` +
            `kv-cache regression scenario was never exercised: ${cancelError.message}`,
        };
      }

      if (!cancelSucceeded) {
        return {
          passed: false,
          output: `First completion ended before cancel (received ${receivedTokens} tokens, expected >=${cancelAfterTokens})`,
        };
      }

      const secondRun = completion({
        modelId,
        history: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: params.secondUserMessage },
        ],
        stream: true,
        kvCache: params.cacheKey,
      });

      let secondText = "";
      for await (const token of secondRun.tokenStream) {
        secondText += token;
      }

      const trimmed = secondText.trim();
      if (trimmed.length === 0) {
        return {
          passed: false,
          output:
            "Second completion on the same kvCache key returned an empty response " +
            "after cancelling the previous streaming turn. Expected the new prompt " +
            "to produce output independent of the cancelled turn.",
        };
      }
      const expected = params.expectedAnswerContains;
      if (!trimmed.toLowerCase().includes(expected.toLowerCase())) {
        return {
          passed: false,
          output:
            `Second completion on the same kvCache key did not include the expected ` +
            `token ${JSON.stringify(expected)} after cancelling the previous ` +
            `streaming turn. Got ${secondText.length} chars: ` +
            `${JSON.stringify(secondText.slice(0, 200))}`,
        };
      }

      return {
        passed: true,
        output:
          `Cancel-then-new-prompt OK: cancelled after ${receivedTokens} tokens, ` +
          `second turn produced ${secondText.length} chars containing ${JSON.stringify(expected)}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Cancel-then-new-prompt failed: ${errorMsg}` };
    }
  }

  async toolsSequentialSave(
    params: { cacheKey: string; tools: unknown[]; messages: string[]; stream: boolean },
    expectation: Expectation,
  ): Promise<TestResult> {
    let toolsModelId = await this.resources.ensureLoaded("tools");

    try {
      try { await deleteCache({ kvCacheKey: params.cacheKey }); } catch { /* ignore ENOENT */ }

      const history: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant with access to tools. Be brief." },
      ];

      let firstCacheTokens = 0;
      let secondCacheTokens = 0;

      for (let i = 0; i < params.messages.length; i++) {
        history.push({ role: "user", content: params.messages[i]! });

        const result = completion({
          modelId: toolsModelId,
          history: [...history],
          stream: true,
          kvCache: params.cacheKey,
          tools: params.tools as never,
        });

        let response = "";
        for await (const token of result.tokenStream) {
          response += token;
        }

        const stats = await result.stats;
        const cacheTokens = (stats as Record<string, unknown>)?.cacheTokens as number ?? 0;

        if (i === 0) {
          firstCacheTokens = cacheTokens;
          history.push({ role: "assistant", content: response });

          // Evict and reload the model to clear the in-memory KV cache.
          // Without this, the addon keeps the session in RAM and the second
          // call would see increased cacheTokens even if the disk save failed.
          await this.resources.evict("tools");
          toolsModelId = await this.resources.ensureLoaded("tools");
        } else {
          secondCacheTokens = cacheTokens;
          history.push({ role: "assistant", content: response });
        }
      }

      // After model reload, the only source of cached tokens is the on-disk
      // file. If the save was silently rejected (missing path) or not awaited,
      // secondCacheTokens will be ≤ firstCacheTokens (system-prompt-only).
      if (secondCacheTokens <= firstCacheTokens) {
        return {
          passed: false,
          output: `KV-cache not persisted to disk between tool-calling completions: second call cache tokens (${secondCacheTokens}) must exceed first call (${firstCacheTokens}). The cache save was likely silently rejected by the addon (missing cache path or unawaited response).`,
        };
      }
      const result = `Tools sequential save: first=${firstCacheTokens}, second=${secondCacheTokens}, cache persisted to disk: true`;
      return ValidationHelpers.validate(result, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Tools sequential save failed: ${errorMsg}` };
    }
  }
}
