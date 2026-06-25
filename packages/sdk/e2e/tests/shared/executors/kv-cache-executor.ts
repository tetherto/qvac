import { cancel, completion, deleteCache } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { kvCacheTests } from "../../kv-cache-tests.js";
import { callWhenAddonIdle } from "../utils/addon-idle.js";

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
      if (test.testId === "kv-cache-remove-thinking-compaction") return [test.testId, this.removeThinkingCompaction.bind(this)];
      if (test.testId === "kv-cache-tools-sequential-save") return [test.testId, this.toolsSequentialSave.bind(this)];
      if (test.testId === "kv-cache-tools-dynamic-reuse") return [test.testId, this.toolsDynamicReuse.bind(this)];
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

  // Retry on a policy-reject so a slot left by a previously wedged test does not poison this one.
  private runCompletion(modelId: string, params: {
    history: ChatMessage[];
    stream?: boolean;
    kvCache?: string | boolean;
    tools?: unknown[];
  }): Promise<string> {
    return callWhenAddonIdle(async () => {
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
    });
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
      if (!cacheUsed) {
        return { passed: false, output: `KV cache not used across turns. ${result}` };
      }
      return ValidationHelpers.validate(result, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Stats verification failed: ${errorMsg}` };
    }
  }

  // Proves `remove_thinking_from_context` is forwarded all the way to the
  // addon and actually compacts the reasoning block: runs the same two-turn
  // conversation twice against a reasoning model (Qwen3 — the "tools"
  // resource is the cross-platform Qwen3 build), once with the flag on and
  // once off, over independent cache keys. With compaction on, turn 1's
  // `<think>` block is dropped from the persisted cache, so turn 2 reloads a
  // smaller prefix and reports fewer `cacheTokens`. A passthrough regression
  // (flag dropped before the addon) collapses the two runs to equal token
  // counts and fails the assertion.
  async removeThinkingCompaction(
    params: { cacheKeyOn: string; cacheKeyOff: string; messages: string[] },
    expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("tools");

    const runSession = async (cacheKey: string, removeThinking: boolean) => {
      try { await deleteCache({ kvCacheKey: cacheKey }); } catch { /* fresh start */ }

      const history: ChatMessage[] = [];
      let lastCacheTokens = 0;

      for (const message of params.messages) {
        history.push({ role: "user", content: message });

        const result = completion({
          modelId,
          history: [...history],
          stream: false,
          kvCache: cacheKey,
          generationParams: { remove_thinking_from_context: removeThinking },
        });

        const text = await result.text;
        const stats = await result.stats;
        lastCacheTokens = ((stats as Record<string, unknown>)?.cacheTokens as number) ?? 0;

        history.push({ role: "assistant", content: text });
      }

      return lastCacheTokens;
    };

    try {
      const onTokens = await runSession(params.cacheKeyOn, true);
      const offTokens = await runSession(params.cacheKeyOff, false);

      const summary = `cacheTokens: remove_thinking on=${onTokens}, off=${offTokens}`;
      if (!(onTokens < offTokens)) {
        return {
          passed: false,
          output: `Expected reasoning-block compaction to shrink the cached prefix going into turn 2. ${summary}`,
        };
      }
      return ValidationHelpers.validate(summary, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `remove_thinking compaction test failed: ${errorMsg}` };
    }
  }

  async cancelThenNewPrompt(
    params: {
      cacheKey: string;
      firstUserMessage: string;
      secondUserMessage: string;
      expectedAnswerContains: string;
      cancelAfterTokens?: number;
      generationParams?: Record<string, unknown>;
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

      // Wrap in callWhenAddonIdle: after cancel() the slot frees asynchronously,
      // so calling completion() directly can race with the cancelled job's cleanup.
      const secondText = await callWhenAddonIdle(async () => {
        const run = completion({
          modelId,
          history: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: params.secondUserMessage },
          ],
          stream: true,
          kvCache: params.cacheKey,
          ...(params.generationParams && { generationParams: params.generationParams }),
        } as never);
        let text = "";
        for await (const token of run.tokenStream) {
          text += token;
        }
        return text;
      });

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

  /**
   * Dynamic tools mode (`toolsMode: "dynamic"`) + a custom kvCache key across a
   * three-round tool chain, with a model evict/reload after the prime turn.
   *
   * Covers a combination no other kv-cache test exercises:
   *
   *   - Round 1 (prime): a user prompt must yield a PARSEABLE tool call under
   *     dynamic mode while the kvCache key is being primed.
   *   - evict + reload: drops the addon's in-memory KV session and the SDK's
   *     in-memory `savedCount` / anchoring, leaving only the on-disk `.bin`.
   *   - Round 2 (continuation, history ends in a `tool` message): exercises the
   *     dynamic "trailing tool messages" fragment branch. Must REUSE the
   *     on-disk cache (`cacheTokens > 0`) after the reload, and stay coherent.
   *   - Round 3 (new prompt, history ends `assistant` then `user`): exercises
   *     the dynamic "[assistant, user]" fragment branch on a warm cache. Must
   *     again yield a PARSEABLE tool call — proving cache reuse did not corrupt
   *     tool parsing.
   */
  async toolsDynamicReuse(
    params: {
      cacheKey: string;
      tools: unknown[];
      firstUserMessage: string;
      secondUserMessage: string;
      toolResult: string;
    },
    expectation: Expectation,
  ): Promise<TestResult> {
    const resourceKey = "tools-dynamic";
    let modelId = await this.resources.ensureLoaded(resourceKey);

    const runTurn = (history: ChatMessage[]) =>
      callWhenAddonIdle(async () => {
        const result = completion({
          modelId,
          history,
          stream: false,
          kvCache: params.cacheKey,
          tools: params.tools as never,
        });
        const text = await result.text;
        const toolCalls = result.toolCalls
          ? ((await result.toolCalls) as Array<{ id: string; name: string }>)
          : [];
        const stats = (await result.stats) as Record<string, unknown> | undefined;
        const cacheTokens = (stats?.cacheTokens as number) ?? 0;
        return { text, toolCalls, cacheTokens };
      });

    try {
      try { await deleteCache({ kvCacheKey: params.cacheKey }); } catch { /* ignore ENOENT */ }

      const system: ChatMessage = {
        role: "system",
        content: "You are a helpful assistant with access to tools. Be brief.",
      };

      // ---- Round 1: prime. Expect a parseable tool call under dynamic mode.
      const r1History: ChatMessage[] = [
        system,
        { role: "user", content: params.firstUserMessage },
      ];
      const r1 = await runTurn(r1History);
      if (r1.toolCalls.length === 0) {
        return {
          passed: false,
          output:
            `Round 1 (prime) under dynamic mode emitted no parseable tool call. ` +
            `Dynamic tool-call format instruction not surfaced, or kvCache prime corrupted the prompt. ` +
            `text=${JSON.stringify(r1.text).slice(0, 200)}`,
        };
      }

      // Feed back the assistant tool-call turn + a tool result (standard
      // agentic loop). History now ends in a `tool` message.
      const r2History: ChatMessage[] = [
        ...r1History,
        { role: "assistant", content: r1.text },
        {
          role: "tool",
          content: `[Tool: ${r1.toolCalls[0]!.name} (${r1.toolCalls[0]!.id})]\n${params.toolResult}`,
        },
      ];

      // ---- Evict + reload: clear in-memory KV session, savedCount, anchoring.
      // Only the on-disk `.bin` survives — the reload-desync scenario.
      await this.resources.evict(resourceKey);
      modelId = await this.resources.ensureLoaded(resourceKey);

      // ---- Round 2: continuation on the reloaded cache (trailing-tool branch).
      // Must reuse the on-disk cache.
      const r2 = await runTurn(r2History);
      if (r2.cacheTokens <= 0) {
        return {
          passed: false,
          output:
            `Round 2 (post-reload continuation) did not reuse the on-disk dynamic-tools cache: ` +
            `cacheTokens=${r2.cacheTokens}. The on-disk cache file was not picked up after reload.`,
        };
      }

      // ---- Round 3: new user prompt after the chain ([assistant, user] branch)
      // on a warm cache. Must still yield a parseable tool call.
      const r3History: ChatMessage[] = [
        ...r2History,
        { role: "assistant", content: r2.text },
        { role: "user", content: params.secondUserMessage },
      ];
      const r3 = await runTurn(r3History);
      if (r3.toolCalls.length === 0) {
        return {
          passed: false,
          output:
            `Round 3 (new prompt on warm dynamic-tools cache) emitted no parseable tool call — ` +
            `cache reuse corrupted tool parsing. r2CacheTokens=${r2.cacheTokens}, ` +
            `r3CacheTokens=${r3.cacheTokens}, text=${JSON.stringify(r3.text).slice(0, 200)}`,
        };
      }

      const summary =
        `Dynamic tools + kvCache reuse OK [${resourceKey}]: ` +
        `r1Calls=${r1.toolCalls.length}, ` +
        `r2CacheTokens=${r2.cacheTokens} (post-reload reuse), ` +
        `r3Calls=${r3.toolCalls.length} (warm), r3CacheTokens=${r3.cacheTokens}`;
      // The harness only surfaces `output` on failure, so log the numbers
      // explicitly — otherwise a passing run hides the reuse magnitude.
      console.log(`[kv-cache-tools-dynamic-reuse] ${summary}`);
      return ValidationHelpers.validate(summary, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Dynamic tools reuse failed: ${errorMsg}` };
    }
  }
}
