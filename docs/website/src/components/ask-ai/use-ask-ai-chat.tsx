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

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
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
        // content?: '...' } }] }`; we accumulate the text deltas into
        // the placeholder assistant message addressed by `id`.
        const stream = await client.chat.completions.create(
          {
            model: INKEEP_MODEL,
            stream: true,
            messages: outboundMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          },
          {
            signal: controller.signal,
            headers:
              Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
          },
        );

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta !== 'string' || delta.length === 0) continue;
          setMessages((current) =>
            current.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, content: m.content + delta }
                : m,
            ),
          );
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
