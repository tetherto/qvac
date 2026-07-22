import {
  countScalars,
  defaultMaxChunkScalars,
} from "./textChunker";

export const DEFAULT_FLUSH_AFTER_MS = 500;

export type SentenceDelimiterPreset =
  | "latin"
  | "cjk"
  | "multilingual";

export interface TextStreamAccumulatorOptions {
  sentenceDelimiter?: RegExp;
  sentenceDelimiterPreset?: SentenceDelimiterPreset;
  maxBufferScalars?: number;
  flushAfterMs?: number;
  language?: string;
}

type QueueItem =
  | { kind: "chunk"; text: string }
  | { kind: "done" }
  | { kind: "err"; error: unknown };

export function splitGraphemeHead(
  value: string,
  count: number,
): { head: string; rest: string } {
  const graphemes = [...value];
  if (graphemes.length <= count) return { head: value, rest: "" };
  return {
    head: graphemes.slice(0, count).join(""),
    rest: graphemes.slice(count).join(""),
  };
}

export function buildSentenceEndTester(
  options: Pick<
    TextStreamAccumulatorOptions,
    "sentenceDelimiter" | "sentenceDelimiterPreset"
  >,
): (buffer: string) => boolean {
  if (options.sentenceDelimiter instanceof RegExp) {
    const expression = options.sentenceDelimiter;
    return function testCustom(buffer: string): boolean {
      expression.lastIndex = 0;
      return expression.test(buffer);
    };
  }
  const patterns: Record<SentenceDelimiterPreset, RegExp> = {
    latin: /[.!?…]\s*$/u,
    cjk: /[。！？…]\s*$/u,
    multilingual: /(?:[.!?…؟]|[。！？…])\s*$/u,
  };
  const preset =
    options.sentenceDelimiterPreset || "multilingual";
  const expression = patterns[preset] || patterns.multilingual;
  return function testPreset(buffer: string): boolean {
    return expression.test(buffer);
  };
}

export function defaultMaxBufferScalars(language?: string): number {
  return defaultMaxChunkScalars(language);
}

export async function* accumulateTextStream(
  source: AsyncIterable<string>,
  options: TextStreamAccumulatorOptions = {},
): AsyncGenerator<string, void, void> {
  const flushAfterMs =
    options.flushAfterMs ?? DEFAULT_FLUSH_AFTER_MS;
  const defaultMaximum = defaultMaxBufferScalars(options.language);
  const configuredMaximum = Number(options.maxBufferScalars);
  const maxScalars =
    options.maxBufferScalars == null ||
    !Number.isFinite(configuredMaximum) ||
    configuredMaximum <= 0
      ? defaultMaximum
      : configuredMaximum;
  const testEnd = buildSentenceEndTester(options);
  const queue: QueueItem[] = [];
  let notify: (() => void) | null = null;

  function push(item: QueueItem): void {
    queue.push(item);
    if (notify) {
      const resolve = notify;
      notify = null;
      resolve();
    }
  }

  void (async function pump(): Promise<void> {
    let buffer = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    function clearIdle(): void {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    function armIdle(): void {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        const text = buffer.trim();
        if (text) {
          buffer = "";
          push({ kind: "chunk", text });
        }
      }, flushAfterMs);
    }

    try {
      for await (const fragment of source) {
        clearIdle();
        buffer += String(fragment);
        while (countScalars(buffer) >= maxScalars) {
          const { head, rest } = splitGraphemeHead(
            buffer,
            maxScalars,
          );
          buffer = rest;
          if (head.length > 0) push({ kind: "chunk", text: head });
        }
        if (testEnd(buffer)) {
          const text = buffer.trim();
          buffer = "";
          if (text) push({ kind: "chunk", text });
        }
        armIdle();
      }
      clearIdle();
      const tail = buffer.trim();
      if (tail) push({ kind: "chunk", text: tail });
      push({ kind: "done" });
    } catch (error) {
      clearIdle();
      push({ kind: "err", error });
    }
  })();

  while (true) {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    const item = queue.shift();
    if (!item || item.kind === "done") return;
    if (item.kind === "err") throw item.error;
    yield item.text;
  }
}
