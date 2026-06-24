'use client';

import OpenAI, { APIError, APIUserAbortError } from 'openai';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import { useInkeepCaptcha } from './use-inkeep-captcha';

/**
 * Inkeep API base. Inkeep's widget calls `${aiApiBaseUrl}/v1/...`
 * where `aiApiBaseUrl` defaults to `https://api.inkeep.com`. We point
 * the OpenAI SDK at the same root so the request shape (URL, body,
 * headers, streaming protocol) matches Inkeep's official widget
 * byte-for-byte — important because Inkeep's server checks for the
 * `X-Stainless-*` fingerprint headers the OpenAI SDK adds. A raw
 * `fetch` skips those and gets 403'd even with a valid key.
 */
const INKEEP_BASE_URL = 'https://api.inkeep.com/v1';
const INKEEP_MODEL = 'inkeep-qa-expert';

/**
 * Tool registration that asks Inkeep's `qa` model to return the
 * sources it used. Inkeep streams these back as a `provideLinks`
 * tool-call whose JSON arguments are `{ links: [...] }`. Declared as a
 * plain JSON schema (no zod helper needed). Inkeep may also stream a
 * `provideRecordsConsidered` tool-call; we ignore everything except
 * `provideLinks`.
 */
const PROVIDE_LINKS_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'provideLinks',
    description: 'Provide the source links (citations) used to answer the question.',
    parameters: {
      type: 'object',
      properties: {
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              url: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              type: { type: 'string' },
            },
            required: ['url'],
          },
        },
      },
      required: ['links'],
    },
  },
};

/**
 * Parse the accumulated JSON arguments of a `provideLinks` tool-call
 * into a clean, de-duplicated reference list. Defensive on every
 * field: a partial / malformed payload yields an empty list rather
 * than throwing (the answer text is still valuable without sources).
 */
function parseProvideLinks(argsJson: string): AskAIReference[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return [];
  }
  const links = (parsed as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return [];

  const seen = new Set<string>();
  const references: AskAIReference[] = [];
  for (const raw of links) {
    if (!raw || typeof raw !== 'object') continue;
    const link = raw as Record<string, unknown>;
    const url = typeof link.url === 'string' ? link.url.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    references.push({
      url,
      title: typeof link.title === 'string' ? link.title : undefined,
      description:
        typeof link.description === 'string' ? link.description : undefined,
      label: typeof link.label === 'string' ? link.label : undefined,
      type: typeof link.type === 'string' ? link.type : undefined,
    });
  }
  return references;
}

export type ChatRole = 'user' | 'assistant' | 'system';

/**
 * A single source link returned by Inkeep's `provideLinks` tool and
 * rendered as a citation beneath the assistant's answer. Mirrors the
 * fields Inkeep emits; only `url` is guaranteed to be present.
 */
export interface AskAIReference {
  url: string;
  title?: string;
  description?: string;
  label?: string;
  type?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /**
   * Source links for an assistant message, attached once the stream
   * finishes (parsed from the `provideLinks` tool call). Absent while
   * streaming and on messages with no citations.
   */
  references?: AskAIReference[];
}

export interface UseAskAIChatOptions {
  /** Inkeep API key. When absent (e.g. env var unset during dev) the
   *  hook degrades to a no-op so the UI still renders. */
  apiKey: string | undefined;
}

export interface UseAskAIChatResult {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  /**
   * Submit the current input (or an override). Adds the user message,
   * appends a streaming assistant message that grows as deltas arrive,
   * and ends with `isStreaming = false`. The optional `prompt`
   * argument lets callers bypass the staged `input` value.
   */
  submit: (event?: FormEvent | null, prompt?: string) => Promise<void>;
  /** Programmatic submit without a form event — used by the bottom
   *  bar's send arrow and by the pending-prompt flush in the shell. */
  send: (prompt: string) => Promise<void>;
  isStreaming: boolean;
  error: Error | null;
  /** Abort the in-flight streaming response. */
  stop: () => void;
  /** Drop all messages and reset to a fresh conversation. */
  clear: () => void;
}

/**
 * Generate a stable-enough ID for a message. Doesn't need crypto
 * uniqueness — `Date.now()` + a per-call counter is enough to avoid
 * React-key collisions within a single page session.
 */
let messageCounter = 0;
function makeId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}-${Date.now()}-${messageCounter}`;
}

/**
 * Turn an OpenAI SDK error into a user-readable string. APIError
 * exposes `status` and `message`; for 4xx responses Inkeep often
 * includes the reason in `error.error` so we surface that too.
 */
function formatError(err: unknown): string {
  if (err instanceof APIError) {
    const status = err.status ? `${err.status}` : 'request error';
    const detail = (err as { error?: { message?: string } | string | null }).error;
    const detailMessage =
      typeof detail === 'string'
        ? detail
        : typeof detail === 'object' && detail && 'message' in detail
          ? detail.message
          : undefined;
    return `Inkeep ${status}: ${detailMessage ?? err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Browser-side chat hook that streams from Inkeep's OpenAI-compatible
 * API via the official `openai` SDK. Maintains its own message state
 * — no AI-SDK / Inkeep React provider needed. The host component is
 * responsible for laying out the messages, the input, and any chrome
 * around them.
 *
 * Conversation state lives in this hook and therefore persists across
 * the chat shell's `closed <-> open <-> expanded` transitions
 * (because the shell itself stays mounted). It does NOT persist
 * across full page reloads — that's deliberate for v1.
 */
export function useAskAIChat({ apiKey }: UseAskAIChatOptions): UseAskAIChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Inkeep gates every chat request behind an ALTCHA proof-of-work
  // challenge. Without a fresh `X-INKEEP-CHALLENGE-SOLUTION` header
  // the API returns 403 even with a valid key. The hook prefetches a
  // solution on mount so the first message is instant.
  const captcha = useInkeepCaptcha();

  // OpenAI client is keyed off `apiKey` — recreated only when the key
  // changes (effectively once on mount). `dangerouslyAllowBrowser`
  // mirrors what Inkeep's own widget passes; the API key in question
  // is a public client-side key intended for browser use.
  const clientRef = useRef<OpenAI | null>(null);
  if (apiKey && clientRef.current === null) {
    clientRef.current = new OpenAI({
      apiKey,
      baseURL: INKEEP_BASE_URL,
      dangerouslyAllowBrowser: true,
    });
  }

  // Holds the in-flight abort controller so `stop()` can cancel
  // mid-stream. Also used by the unmount cleanup so we don't leak a
  // dangling fetch when the user navigates away mid-response.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setInput('');
    setIsStreaming(false);
    setError(null);
  }, []);

  const send = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const client = clientRef.current;
      if (!client) {
        setError(new Error('Inkeep API key is not configured.'));
        return;
      }

      // Cancel any in-flight stream before starting a new one. This
      // lets the user fire off a follow-up without waiting for the
      // previous response to finish.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMessage: ChatMessage = {
        id: makeId('u'),
        role: 'user',
        content: trimmed,
      };
      const assistantMessage: ChatMessage = {
        id: makeId('a'),
        role: 'assistant',
        content: '',
      };

      // Build the full transcript (existing + new user turn) for the
      // request body. We read from current React state via a functional
      // setter so the request always has the latest history even when
      // multiple `send()` calls race.
      let outboundMessages: ChatMessage[] = [];
      setMessages((current) => {
        const next = [...current, userMessage, assistantMessage];
        outboundMessages = [...current, userMessage];
        return next;
      });

      setInput('');
      setIsStreaming(true);
      setError(null);

      try {
        // Solve the ALTCHA challenge and attach it as a request
        // header. Inkeep's edge will 403 the request without it.
        const solutionHeader = await captcha.getSolutionHeader();
        const requestHeaders: Record<string, string> = {};
        if (solutionHeader) {
          requestHeaders['X-INKEEP-CHALLENGE-SOLUTION'] = solutionHeader;
        }

        // Use the SDK's streaming method (same one Inkeep's widget
        // calls). Stream events look like `{ choices: [{ delta: {
        // content?: '...', tool_calls?: [...] } }] }`; we accumulate
        // the text deltas into the placeholder assistant message and
        // the `provideLinks` tool-call arguments into `toolCallArgs`
        // (keyed by the call index, since fragments arrive split
        // across chunks).
        const stream = await client.chat.completions.create(
          {
            model: INKEEP_MODEL,
            stream: true,
            messages: outboundMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            tools: [PROVIDE_LINKS_TOOL],
            tool_choice: 'auto',
          },
          {
            signal: controller.signal,
            headers:
              Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
          },
        );

        const toolCallArgs = new Map<number, { name: string; args: string }>();

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            const text = delta.content;
            setMessages((current) =>
              current.map((m) =>
                m.id === assistantMessage.id
                  ? { ...m, content: m.content + text }
                  : m,
              ),
            );
          }

          if (delta.tool_calls) {
            for (const call of delta.tool_calls) {
              const entry = toolCallArgs.get(call.index) ?? { name: '', args: '' };
              if (call.function?.name) entry.name = call.function.name;
              if (call.function?.arguments) entry.args += call.function.arguments;
              toolCallArgs.set(call.index, entry);
            }
          }
        }

        // Stream finished cleanly: surface any citations Inkeep
        // returned via the `provideLinks` tool-call.
        const linksCall = [...toolCallArgs.values()].find(
          (call) => call.name === 'provideLinks',
        );
        if (linksCall) {
          const references = parseProvideLinks(linksCall.args);
          if (references.length > 0) {
            setMessages((current) =>
              current.map((m) =>
                m.id === assistantMessage.id ? { ...m, references } : m,
              ),
            );
          }
        }
      } catch (caught) {
        if (caught instanceof APIUserAbortError) {
          // User-initiated stop; not an error to surface.
        } else if (
          caught instanceof DOMException &&
          caught.name === 'AbortError'
        ) {
          // Same as above; some abort paths surface as DOMException.
        } else {
          // Auth / rate-limit failures invalidate the prefetched
          // captcha so the next attempt forces a fresh challenge.
          if (caught instanceof APIError && (caught.status === 401 || caught.status === 403)) {
            captcha.invalidate();
          }
          const message = formatError(caught);
          setError(new Error(message));
          // Replace the empty assistant placeholder with the error
          // message so the user sees what happened.
          setMessages((current) =>
            current.map((m) =>
              m.id === assistantMessage.id && m.content.length === 0
                ? {
                    ...m,
                    content: `Sorry, something went wrong: ${message}`,
                  }
                : m,
            ),
          );
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [captcha],
  );

  const submit = useCallback(
    async (event?: FormEvent | null, prompt?: string) => {
      event?.preventDefault();
      const text = prompt ?? input;
      await send(text);
    },
    [input, send],
  );

  return { messages, input, setInput, submit, send, isStreaming, error, stop, clear };
}
