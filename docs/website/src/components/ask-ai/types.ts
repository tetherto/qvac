/**
 * Shared types for the Ask AI assistant surface (sidebar on desktop,
 * full-screen modal on mobile).
 */

/**
 * A snippet of context that the user wants the AI assistant to consider
 * before they type the actual question. Currently captured from two places:
 *
 * - "Ask AI" button rendered into every code block (carries the snippet
 *   text + the language tag picked up from the Shiki container).
 * - "Add to assistant" popup shown when the user selects text inside the
 *   docs body.
 *
 * The snippet is queued on the provider as `pendingContext` and flushed
 * into the chat input the next time the surface mounts/opens.
 */
export type AskAIContextSnippet = {
  text: string;
  language?: string;
  source: 'selection' | 'code-block';
  /**
   * Optional URL the snippet was captured from, used so the assistant has
   * a stable anchor when the user follows up later in the conversation.
   */
  href?: string;
};
