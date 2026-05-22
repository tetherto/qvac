'use client';

import { AskAIChatShell } from './ask-ai-chat-shell';

/**
 * Mounts the unified chat shell. The shell itself is responsive -
 * one component renders on every breakpoint - so this file is a thin
 * wrapper kept for back-compat with the existing call sites that
 * import `AskAIShell` from `@/components/ask-ai`.
 *
 * The previous Inkeep-based mobile / desktop split lived here; that
 * code is gone in favor of a single custom UI built on Inkeep's
 * OpenAI-compatible API. See `ask-ai-chat-shell.tsx` and
 * `use-ask-ai-chat.tsx`.
 */
export function AskAIShell() {
  return <AskAIChatShell />;
}
