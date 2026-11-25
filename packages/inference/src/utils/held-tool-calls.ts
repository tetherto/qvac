import type { ToolCall } from '@/schemas/index'

export type HeldToolCalls = ReturnType<typeof createHeldToolCalls>

/**
 * Closed tool-call frames whose fate depends on the text after them. More
 * frames, whitespace and markup keep the group held; prose makes the whole
 * group examples, shown as text; the end of the turn, or a failed call
 * attempt, makes them calls. The owner decides which, then `take`s the group.
 */
export function createHeldToolCalls() {
  let raw = ''
  let calls: ToolCall[] = []

  return {
    get active() {
      return calls.length > 0
    },
    // A closed frame joins the group: its text and the calls parsed from it.
    hold(text: string, frameCalls: readonly ToolCall[]) {
      raw += text
      calls.push(...frameCalls)
    },
    // Text between frames, shown with them if they turn out to be examples.
    pad(text: string) {
      if (calls.length > 0) raw += text
    },
    take() {
      const held = { raw, calls }
      raw = ''
      calls = []
      return held
    }
  }
}
