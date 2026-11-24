import type {
  CompletionEvent,
  CompletionError,
  CompletionStats,
  NormalizerConfig,
  StopReason,
  ToolCall
} from '@/schemas/index'
import { parseToolCalls } from '@/utils/tools/index'
import {
  BARE_FUNCTION_CLOSE,
  BARE_FUNCTION_OPEN,
  bareFunctionBodyStart,
  bareFunctionNameLength
} from '@/utils/tools/parsers/qwen35'

type NormalizerState =
  | 'content'
  | 'thinkingFraming'
  | 'toolFraming'
  | 'contentFraming'
  | 'afterThinkingTool'
  | 'afterTool'

type FrameSpec = {
  open: string
  close: string
  // An opener that is also ordinary text: it frames a call only once a valid
  // `NAME>` follows, and a frame that recovers nothing is returned as text.
  bare?: boolean
}

const BARE_FUNCTION_FRAME: FrameSpec = {
  open: BARE_FUNCTION_OPEN,
  close: BARE_FUNCTION_CLOSE,
  bare: true
}

// Special-token-shaped markers a template emits after a call (`<|tool_response>`,
// `<|start|>assistant`); they say nothing about whether the call was made.
const PROTOCOL_TOKEN = /^(?:<\|[^<>\s]{0,40}>(?:assistant)?|<[^<>\s|]{1,40}\|>|<｜[^<>]{0,40}>)/
const MAX_PENDING_PROTOCOL_TOKEN = 48
const ROLE_SUFFIX = 'assistant'

export const MAX_TOOL_FRAME_CHARS = 1_048_576

// Always-stripped protocol markers emitted by the model's chat template.
// The capture-gated `<think>` convention lives separately (BUILTIN_THINKING).
type DialectSpec = {
  // Tool-call frames — parsed via `parseToolCalls(_, dialect)`.
  toolFrames: readonly FrameSpec[]
  // Reasoning frames stripped unconditionally; inner emitted as
  // `thinkingDelta` when `captureThinking` is true.
  thinkingFrames?: readonly FrameSpec[]
  // Content-unwrap frames — inner streamed as `contentDelta`; trailing
  // partial-close tail buffered until resolved.
  contentFrames?: readonly FrameSpec[]
  // Standalone glue tokens stripped without state transition.
  dropTokens?: readonly string[]
  // Markers too short to register without stealing longer split markers.
  contentDropTokens?: readonly string[]
  // The template ends the turn at a call, so text after one makes it an example.
  callEndsTurn?: boolean
}

type Dialect = NonNullable<NormalizerConfig['toolDialect']>

const DSML_INVOKE_FRAMES: readonly FrameSpec[] = [' ', '\n', '\t', '\r'].map((sep) => ({
  open: `<｜DSML｜invoke${sep}`,
  close: '</｜DSML｜invoke>'
}))

const DIALECT_SPECS: Record<Dialect, DialectSpec> = {
  hermes: {
    toolFrames: [{ open: '<tool_call>', close: '</tool_call>' }, BARE_FUNCTION_FRAME]
  },
  // No streaming framing — tool calls are only recovered at finalization.
  json: {
    toolFrames: []
  },
  pythonic: {
    toolFrames: [
      { open: '<|tool_call_start|>', close: '<|tool_call_end|>' },
      {
        open: '<|start_header_id|>tool_call<|end_header_id|>',
        close: '<|eot_id|>'
      }
    ]
  },
  harmony: {
    toolFrames: [{ open: '<|channel|>commentary to=functions.', close: '<|call|>' }],
    thinkingFrames: [{ open: '<|channel|>analysis<|message|>', close: '<|end|>' }],
    contentFrames: [
      { open: '<|channel|>final<|message|>', close: '<|return|>' },
      { open: '<|channel|>assistant<|message|>', close: '<|end|>' }
    ],
    // Role headers and stray Harmony control tokens between frames.
    dropTokens: [
      '<|message|>',
      '<|end|>',
      '<|start|>assistant',
      '<|start|>system',
      '<|start|>user',
      '<|return|>'
    ],
    contentDropTokens: ['<|channel|>'],
    callEndsTurn: true
  },
  qwen35: {
    // Same <tool_call>…</tool_call> framing as hermes; inner content is XML.
    toolFrames: [{ open: '<tool_call>', close: '</tool_call>' }, BARE_FUNCTION_FRAME],
    callEndsTurn: true
  },
  gemma4: {
    toolFrames: [{ open: '<|tool_call>', close: '<tool_call|>' }],
    thinkingFrames: [{ open: '<|channel>thought', close: '<channel|>' }],
    callEndsTurn: true
  },
  dsml: {
    toolFrames: [
      { open: '<｜DSML｜tool_calls>', close: '</｜DSML｜tool_calls>' },
      { open: '<｜DSML｜function_calls>', close: '</｜DSML｜function_calls>' },
      ...DSML_INVOKE_FRAMES
    ],
    callEndsTurn: true
  }
}

// Capture-gated reasoning marker — the generic `<think>...</think>`
// convention used by reasoning-tuned models. When the gate is off the
// markers pass through into `contentDelta` unchanged (preserves the
// pre-dialect behavior).
const BUILTIN_THINKING: FrameSpec = { open: '<think>', close: '</think>' }

type FrameKind = 'tool' | 'thinking' | 'content'

export type CompletionNormalizer = ReturnType<typeof createCompletionNormalizer>

export function createCompletionNormalizer(config: NormalizerConfig) {
  let seq = 0
  let state: NormalizerState = 'content'
  let rawText = ''
  const contentParts: string[] = []
  const thinkingParts: string[] = []

  // Tool frame: buffer keeps the open + close markers in place so
  // `parseToolCalls` can match its own dialect markers.
  let toolCallBuffer = ''
  let activeToolFrame: FrameSpec | null = null
  let bareBodySeen = false

  // Only calls at the end of the turn are made: frames followed by more prose
  // were examples. Closed frames separated only by whitespace or protocol
  // tokens wait here together; visible text demotes them all, the turn end
  // or a frame that fails to parse makes them.
  let trailingCalls: { raw: string; calls: ToolCall[] } | null = null
  const demotedToolCallKeys = new Set<string>()

  // Thinking frame: tracks which frame's close marker we're scanning for
  // (could be the built-in `<think>` or a dialect-specific frame like
  // Harmony's `<|channel|>analysis<|message|>...<|end|>`).
  let activeThinkingFrame: FrameSpec | null = null

  // Qwen-style templates open `<think>` in the prompt and the model sometimes
  // skips `</think>` before calling a tool. A call parsed inside the block is
  // held until what follows shows whether it was made or only quoted.
  let toolFrameOpenedInThinking = false
  let heldThinkingCalls: { raw: string; calls: ToolCall[] } | null = null
  // Index into `thinkingParts` where the current built-in block starts.
  let thinkingBlockStart = 0
  // Calls in the current block from the first one followed by more reasoning.
  // That kind was quoted if the block closes and made if the turn ends with it
  // open; calls made after it wait here so they are emitted in order.
  let deferredCalls: { call: ToolCall; made: boolean }[] = []
  let undecidedAnswerStart = 0

  // Content frame: inner streamed as it arrives; partial close tail buffered.
  let activeContentFrame: FrameSpec | null = null

  // Set when a thinking frame closes before any content. Reasoning templates
  // put a blank line between the close marker and the answer; it belongs to
  // the framing, not the answer, so whitespace is dropped until the answer's
  // first visible character.
  let trimAfterThinking = false

  // The same framing whitespace sits inside a thinking frame (`<think>\n` ...
  // `\n</think>`). Leading whitespace is dropped and trailing whitespace held
  // back until more reasoning follows, so the close drops it. Both reset when a
  // frame opens; a later frame starts on a new line so frames don't run together.
  let trimThinkingStart = false
  let pendingThinkingWhitespace = ''

  // Trailing chars that could be a prefix of a watched marker, so markers
  // split across token pushes aren't missed by indexOf.
  let contentTail = ''
  let toolFramingTail = ''
  let thinkingFramingTail = ''
  let contentFramingTail = ''
  let afterThinkingToolTail = ''
  let afterToolTail = ''

  const streamedToolCallKeys = new Set<string>()

  const toolsEnabled = config.tools.length > 0 && config.capabilities.toolCalling !== 'none'
  const useToolFraming = toolsEnabled && config.capabilities.toolCalling === 'textParse'
  // Register `<think>` only when both capability + capture opt in.
  // Dialect protocol markers always register; capture only gates emission.
  const useBuiltinThinkTags =
    config.captureThinking && config.capabilities.thinkingFraming === 'thinkTags'

  const dialect: Dialect = config.toolDialect ?? 'hermes'
  const dialectSpec = DIALECT_SPECS[dialect]

  const toolFrames: readonly FrameSpec[] = useToolFraming ? dialectSpec.toolFrames : []
  const thinkingFrames: readonly FrameSpec[] = [
    ...(useBuiltinThinkTags ? [BUILTIN_THINKING] : []),
    ...(dialectSpec.thinkingFrames ?? [])
  ]
  const contentFrames: readonly FrameSpec[] = dialectSpec.contentFrames ?? []
  const dropTokens: readonly string[] = dialectSpec.dropTokens ?? []
  const contentDropTokens: readonly string[] = dialectSpec.contentDropTokens ?? []

  const markerToEntry = new Map<string, { kind: FrameKind; spec: FrameSpec }>()
  const dropTokenSet = new Set<string>()
  const contentMarkers: string[] = []
  function registerFrames(frames: readonly FrameSpec[], kind: FrameKind) {
    for (const f of frames) {
      if (markerToEntry.has(f.open)) continue
      markerToEntry.set(f.open, { kind, spec: f })
      contentMarkers.push(f.open)
    }
  }
  registerFrames(toolFrames, 'tool')
  const toolOpeners: readonly string[] = toolFrames.map((f) => f.open)
  registerFrames(thinkingFrames, 'thinking')
  registerFrames(contentFrames, 'content')
  for (const t of dropTokens) {
    if (markerToEntry.has(t) || dropTokenSet.has(t)) continue
    dropTokenSet.add(t)
    contentMarkers.push(t)
  }

  function nextSeq() {
    return seq++
  }

  function emitContent(events: CompletionEvent[], text: string) {
    let normalized = text
    for (const token of contentDropTokens) {
      normalized = normalized.split(token).join('')
    }
    if (trimAfterThinking) {
      normalized = normalized.trimStart()
      if (normalized) trimAfterThinking = false
    }
    if (!normalized) return
    if (trailingCalls) {
      if (!normalized.trim()) {
        trailingCalls.raw += normalized
        return
      }
      demoteTrailingCalls(events)
    }
    contentParts.push(normalized)
    events.push({ type: 'contentDelta', seq: nextSeq(), text: normalized })
  }

  // Capture-gated: thinking frames may register even when `captureThinking`
  // is false (e.g. harmony's analysis channel, to strip markers from
  // `contentDelta`) — drop the inner here instead of buffering it.
  function emitThinking(events: CompletionEvent[], text: string) {
    let normalized = text
    if (trimThinkingStart) {
      normalized = normalized.trimStart()
      if (!normalized) return
      trimThinkingStart = false
      if (thinkingParts.length > 0) normalized = '\n' + normalized
    }
    const body = normalized.trimEnd()
    if (!body) {
      pendingThinkingWhitespace += normalized
      return
    }
    const out = pendingThinkingWhitespace + body
    pendingThinkingWhitespace = normalized.slice(body.length)
    if (config.captureThinking) {
      thinkingParts.push(out)
      events.push({ type: 'thinkingDelta', seq: nextSeq(), text: out })
    }
  }

  function getToolCallKey(call: ToolCall) {
    return `${call.name}:${JSON.stringify(call.arguments)}`
  }

  function emitStreamedToolCall(events: CompletionEvent[], call: ToolCall) {
    streamedToolCallKeys.add(getToolCallKey(call))
    events.push({ type: 'toolCall', seq: nextSeq(), call })
  }

  // A made call waits behind earlier undecided ones so the order is kept.
  function emitMadeCall(events: CompletionEvent[], call: ToolCall) {
    releaseTrailingCalls(events)
    if (deferredCalls.length > 0) deferredCalls.push({ call, made: true })
    else emitStreamedToolCall(events, call)
  }

  function emitFinalToolCall(events: CompletionEvent[], call: ToolCall) {
    const key = getToolCallKey(call)
    if (streamedToolCallKeys.has(key) || demotedToolCallKeys.has(key)) return
    events.push({ type: 'toolCall', seq: nextSeq(), call })
  }

  // Length of the longest suffix of `buf` that is also a prefix of any marker.
  function trailingPartialMarkerLen(buf: string, markers: readonly string[]) {
    if (markers.length === 0 || buf.length === 0) return 0
    const maxLen = Math.min(buf.length, markers.reduce((m, s) => Math.max(m, s.length), 0) - 1)
    for (let len = maxLen; len > 0; len--) {
      const suffix = buf.slice(buf.length - len)
      for (const m of markers) {
        if (m.startsWith(suffix)) return len
      }
    }
    return 0
  }

  type EarliestMatch = { idx: number; marker: string }
  function findEarliestMarker(buf: string, markers: readonly string[]): EarliestMatch | null {
    let best: EarliestMatch | null = null
    for (const m of markers) {
      const i = buf.indexOf(m)
      if (i < 0) continue
      if (best === null || i < best.idx) best = { idx: i, marker: m }
    }
    return best
  }

  function openToolFrame(marker: string, spec: FrameSpec, fromThinking: boolean) {
    toolCallBuffer = marker
    activeToolFrame = spec
    toolFrameOpenedInThinking = fromThinking
    bareBodySeen = false
    state = 'toolFraming'
  }

  // Every exit from a tool frame goes through here, so no frame state outlives it.
  function takeToolFrame() {
    const taken = {
      raw: toolCallBuffer + toolFramingTail,
      frame: activeToolFrame,
      openedInThinking: toolFrameOpenedInThinking
    }
    toolCallBuffer = ''
    toolFramingTail = ''
    activeToolFrame = null
    toolFrameOpenedInThinking = false
    return taken
  }

  // An unfinished bare block naming a declared tool is a cut-off call, not prose.
  function namesDeclaredTool(raw: string, frame: FrameSpec) {
    const rest = raw.slice(frame.open.length)
    const nameLength = bareFunctionNameLength(rest)
    if (nameLength <= 0) return false
    const name = rest.slice(0, nameLength - 1).trim()
    return config.tools.some((tool) => tool.name === name)
  }

  function flushToolBuffer(events: CompletionEvent[], closed: boolean) {
    const { raw, frame, openedInThinking } = takeToolFrame()

    if (!frame) return

    // Empty-payload guard. Strip frame markers and check the inner is
    // non-empty; surface a toolError on empty payloads so the literal
    // markers don't leak into contentDelta.
    let inner = raw
    if (inner.startsWith(frame.open)) inner = inner.slice(frame.open.length)
    if (inner.endsWith(frame.close)) {
      inner = inner.slice(0, inner.length - frame.close.length)
    }
    if (inner.trim().length === 0) {
      if (openedInThinking) return returnToThinking(events, raw)
      releaseTrailingCalls(events)
      events.push({
        type: 'toolError',
        seq: nextSeq(),
        error: { code: 'PARSE_ERROR', message: 'Empty tool_call frame' }
      })
      return
    }

    const { toolCalls, errors } = parseToolCalls(raw, config.tools, dialect)

    if (openedInThinking) {
      if (toolCalls.length === 0) return returnToThinking(events, raw)
      if (closed) {
        heldThinkingCalls = { raw, calls: toolCalls }
        state = 'afterThinkingTool'
        return
      }
    }

    if (frame.bare && toolCalls.length === 0 && errors.length === 0) {
      if (!closed && namesDeclaredTool(raw, frame)) releaseTrailingCalls(events)
      emitContent(events, raw)
      return
    }

    // Where the template does not end the turn at a call, a wrapped call is made
    // as soon as it closes. A bare block is always held: it may be an example.
    const holdCalls = frame.bare || dialectSpec.callEndsTurn
    if (closed && toolCalls.length > 0 && !openedInThinking && holdCalls) {
      if (trailingCalls) {
        trailingCalls.raw += raw
        trailingCalls.calls.push(...toolCalls)
      } else {
        trailingCalls = { raw, calls: toolCalls }
      }
      state = 'afterTool'
      return
    }

    // A failed call attempt is not prose: the calls before it were made.
    releaseTrailingCalls(events)
    for (const call of toolCalls) emitMadeCall(events, call)

    if (toolCalls.length === 0) {
      if (errors.length > 0) {
        for (const error of errors) {
          events.push({ type: 'toolError', seq: nextSeq(), error })
        }
      } else {
        events.push({
          type: 'toolError',
          seq: nextSeq(),
          error: {
            code: 'PARSE_ERROR',
            message: closed
              ? 'Failed to parse tool call from framed region'
              : 'Incomplete tool call frame at stream end',
            raw
          }
        })
      }
      emitContent(events, raw)
    }
  }

  function abandonToolFrame(events: CompletionEvent[]) {
    const { raw, frame, openedInThinking } = takeToolFrame()
    state = 'content'
    if (frame?.bare && openedInThinking) return returnToThinking(events, raw)
    if (frame?.bare) {
      if (namesDeclaredTool(raw, frame)) releaseTrailingCalls(events)
      return emitContent(events, raw)
    }

    releaseTrailingCalls(events)
    events.push({
      type: 'toolError',
      seq: nextSeq(),
      error: {
        code: 'PARSE_ERROR',
        message: `Tool call frame exceeded ${MAX_TOOL_FRAME_CHARS} characters without a close marker`
      }
    })
    emitContent(events, raw)
  }

  function getStateTail() {
    switch (state) {
      case 'content':
        return contentTail
      case 'thinkingFraming':
        return thinkingFramingTail
      case 'toolFraming':
        return toolFramingTail
      case 'contentFraming':
        return contentFramingTail
      case 'afterThinkingTool':
        return afterThinkingToolTail
      case 'afterTool':
        return afterToolTail
    }
  }

  // A bare opener not followed by `NAME>` was text; `rest` is what came after it.
  // The reasoning only mentioned a tool marker: the text goes back to `<think>`.
  function returnToThinking(events: CompletionEvent[], text: string) {
    trimThinkingStart = false
    emitThinking(events, text)
    activeThinkingFrame = BUILTIN_THINKING
    state = 'thinkingFraming'
  }

  function releaseBareOpener(events: CompletionEvent[], rest: string) {
    const { frame, openedInThinking } = takeToolFrame()
    const opener = frame?.open ?? ''
    if (openedInThinking) {
      returnToThinking(events, opener)
    } else {
      state = 'content'
      emitContent(events, opener)
    }
    return rest
  }

  function releaseTrailingCalls(events: CompletionEvent[]) {
    const held = trailingCalls
    trailingCalls = null
    for (const call of held?.calls ?? []) emitMadeCall(events, call)
  }

  function demoteTrailingCalls(events: CompletionEvent[]) {
    const held = trailingCalls
    trailingCalls = null
    if (!held) return
    for (const call of held.calls) demotedToolCallKeys.add(getToolCallKey(call))
    emitContent(events, held.raw)
  }

  function stepAfterTool(events: CompletionEvent[], buf: string) {
    let rest = buf
    for (;;) {
      // Whitespace joins the held group as it arrives, so it is never rescanned.
      const trimmed = rest.trimStart()
      trailingCalls!.raw += rest.slice(0, rest.length - trimmed.length)
      rest = trimmed
      if (!trimmed) return ''
      const opener = toolOpeners.find((m) => trimmed.startsWith(m))
      if (opener) {
        // The next frame joins the held group; the text after it decides them all.
        openToolFrame(opener, markerToEntry.get(opener)!.spec, false)
        return trimmed.slice(opener.length)
      }
      // A split opener (`<|channel|>comm…`) must not be taken for a protocol token.
      if (toolOpeners.some((m) => m.startsWith(trimmed))) {
        afterToolTail = rest
        return ''
      }
      const token = PROTOCOL_TOKEN.exec(trimmed)
      if (token) {
        const after = trimmed.slice(token[0].length)
        // `<|start|>` may still be followed by `assistant` in the next push.
        if (
          token[0].startsWith('<|') &&
          !token[0].endsWith(ROLE_SUFFIX) &&
          after.length < ROLE_SUFFIX.length &&
          ROLE_SUFFIX.startsWith(after)
        ) {
          afterToolTail = rest
          return ''
        }
        rest = after
        continue
      }
      if (
        trimmed[0] === '<' &&
        !trimmed.includes('>') &&
        trimmed.length < MAX_PENDING_PROTOCOL_TOKEN
      ) {
        afterToolTail = rest
        return ''
      }
      demoteTrailingCalls(events)
      state = 'content'
      return rest
    }
  }

  // Each step consumes what it can of `buf` in the current state and returns the rest.
  function stepToolFraming(events: CompletionEvent[], buf: string) {
    if (!activeToolFrame) {
      state = 'content'
      return buf
    }
    // A bare opener frames a call only once `NAME>` and the start of a body
    // follow; until then it is held, and anything else streams as text.
    if (activeToolFrame.bare && !bareBodySeen) {
      const rest = toolCallBuffer.slice(activeToolFrame.open.length) + buf
      const nameLength = bareFunctionNameLength(rest)
      const bodyStart = nameLength > 0 ? bareFunctionBodyStart(rest.slice(nameLength)) : 0
      if (nameLength < 0 || bodyStart < 0) return releaseBareOpener(events, rest)
      if (nameLength === 0 || bodyStart === 0) {
        toolCallBuffer += buf
        return ''
      }
      bareBodySeen = true
      toolCallBuffer = activeToolFrame.open
      buf = rest
    }

    const close = activeToolFrame.close
    const hit = buf.indexOf(close)

    // `</think>` before the frame closes: the reasoning only mentioned the
    // opener, so the buffered text goes back to reasoning.
    const thinkClose = toolFrameOpenedInThinking ? buf.indexOf(BUILTIN_THINKING.close) : -1
    if (thinkClose >= 0 && (hit < 0 || thinkClose < hit)) {
      const { raw } = takeToolFrame()
      trimThinkingStart = false
      emitThinking(events, raw + buf.slice(0, thinkClose))
      closeThinkingBlock(events)
      return buf.slice(thinkClose + BUILTIN_THINKING.close.length)
    }

    if (hit >= 0) {
      toolCallBuffer += buf.slice(0, hit + close.length)
      state = 'content'
      flushToolBuffer(events, true)
      return buf.slice(hit + close.length)
    }

    const tailLen = trailingPartialMarkerLen(
      buf,
      toolFrameOpenedInThinking ? [close, BUILTIN_THINKING.close] : [close]
    )
    const safeLen = buf.length - tailLen
    toolCallBuffer += buf.slice(0, safeLen)
    toolFramingTail = buf.slice(safeLen)
    if (toolCallBuffer.length > MAX_TOOL_FRAME_CHARS) abandonToolFrame(events)
    return ''
  }

  function closeThinkingBlock(events: CompletionEvent[]) {
    for (const { call, made } of deferredCalls) if (made) emitStreamedToolCall(events, call)
    deferredCalls = []
    activeThinkingFrame = null
    trimAfterThinking = contentParts.length === 0
    state = 'content'
  }

  function releaseHeldCalls(events: CompletionEvent[]) {
    const held = heldThinkingCalls
    heldThinkingCalls = null
    for (const call of held?.calls ?? []) emitMadeCall(events, call)
  }

  // A held call was made if the turn ends, `</think>` closes the block, or
  // another call follows. Any other text means the reasoning quoted it.
  function stepAfterThinkingTool(events: CompletionEvent[], buf: string) {
    const rest = buf.trimStart()
    const markers = [BUILTIN_THINKING.close, ...toolOpeners]
    const marker = markers.find((m) => rest.startsWith(m))
    if (marker) {
      releaseHeldCalls(events)
      if (marker === BUILTIN_THINKING.close) {
        closeThinkingBlock(events)
      } else {
        openToolFrame(marker, markerToEntry.get(marker)!.spec, true)
      }
      return rest.slice(marker.length)
    }
    if (markers.some((m) => m.startsWith(rest))) {
      afterThinkingToolTail = buf
      return ''
    }
    const held = heldThinkingCalls
    heldThinkingCalls = null
    trimThinkingStart = false
    emitThinking(events, (held?.raw ?? '') + buf.slice(0, buf.length - rest.length))
    for (const call of held?.calls ?? []) deferredCalls.push({ call, made: false })
    undecidedAnswerStart = thinkingParts.length
    activeThinkingFrame = BUILTIN_THINKING
    state = 'thinkingFraming'
    return rest
  }

  function stepThinkingFraming(events: CompletionEvent[], buf: string) {
    if (!activeThinkingFrame) {
      state = 'content'
      return buf
    }
    const builtin = activeThinkingFrame === BUILTIN_THINKING
    const closeMarker = activeThinkingFrame.close
    const closeIdx = buf.indexOf(closeMarker)
    const toolOpen = builtin ? findEarliestMarker(buf, toolOpeners) : null
    if (toolOpen && (closeIdx < 0 || toolOpen.idx < closeIdx)) {
      emitThinking(events, buf.slice(0, toolOpen.idx))
      activeThinkingFrame = null
      openToolFrame(toolOpen.marker, markerToEntry.get(toolOpen.marker)!.spec, true)
      return buf.slice(toolOpen.idx + toolOpen.marker.length)
    }
    if (closeIdx >= 0) {
      emitThinking(events, buf.slice(0, closeIdx))
      closeThinkingBlock(events)
      return buf.slice(closeIdx + closeMarker.length)
    }
    const tailLen = trailingPartialMarkerLen(
      buf,
      builtin ? [closeMarker, ...toolOpeners] : [closeMarker]
    )
    const safeLen = buf.length - tailLen
    emitThinking(events, buf.slice(0, safeLen))
    thinkingFramingTail = buf.slice(safeLen)
    return ''
  }

  function processSegment(events: CompletionEvent[], text: string) {
    let buf = getStateTail() + text

    contentTail = ''
    thinkingFramingTail = ''
    toolFramingTail = ''
    contentFramingTail = ''
    afterThinkingToolTail = ''
    afterToolTail = ''

    while (buf.length > 0) {
      if (state === 'afterTool') {
        buf = stepAfterTool(events, buf)
        continue
      }

      if (state === 'toolFraming') {
        buf = stepToolFraming(events, buf)
        continue
      }

      if (state === 'thinkingFraming') {
        buf = stepThinkingFraming(events, buf)
        continue
      }

      if (state === 'afterThinkingTool') {
        buf = stepAfterThinkingTool(events, buf)
        continue
      }

      if (state === 'contentFraming') {
        if (!activeContentFrame) {
          state = 'content'
          continue
        }
        const closeMarker = activeContentFrame.close
        const closeIdx = buf.indexOf(closeMarker)
        if (closeIdx >= 0) {
          emitContent(events, buf.slice(0, closeIdx))
          activeContentFrame = null
          contentFramingTail = ''
          buf = buf.slice(closeIdx + closeMarker.length)
          state = 'content'
          continue
        }
        const tailLen = trailingPartialMarkerLen(buf, [closeMarker])
        const safeLen = buf.length - tailLen
        emitContent(events, buf.slice(0, safeLen))
        contentFramingTail = buf.slice(safeLen)
        buf = ''
        continue
      }

      const hit = findEarliestMarker(buf, contentMarkers)
      if (hit) {
        emitContent(events, buf.slice(0, hit.idx))
        buf = buf.slice(hit.idx + hit.marker.length)

        if (dropTokenSet.has(hit.marker)) {
          // Glue token between frames — strip and stay in content state.
          continue
        }

        const entry = markerToEntry.get(hit.marker)!
        // A content frame (Harmony's final channel) carries the answer itself,
        // so the trim carries into it; any other frame ends it.
        if (entry.kind !== 'content') trimAfterThinking = false
        if (entry.kind === 'tool') {
          openToolFrame(hit.marker, entry.spec, false)
        } else if (entry.kind === 'thinking') {
          activeThinkingFrame = entry.spec
          thinkingBlockStart = thinkingParts.length
          deferredCalls = []
          trimThinkingStart = true
          pendingThinkingWhitespace = ''
          state = 'thinkingFraming'
        } else {
          activeContentFrame = entry.spec
          state = 'contentFraming'
        }
        continue
      }

      const tailLen = trailingPartialMarkerLen(buf, contentMarkers)
      const safeLen = buf.length - tailLen
      emitContent(events, buf.slice(0, safeLen))
      contentTail = buf.slice(safeLen)
      buf = ''
    }
  }

  function push(token: string): CompletionEvent[] {
    const events: CompletionEvent[] = []
    rawText += token

    if (config.emitRawDeltas) {
      events.push({ type: 'rawDelta', seq: nextSeq(), text: token })
    }

    processSegment(events, token)
    return events
  }

  // Emits tail bytes held back while a marker might still be arriving.
  function drainTails(events: CompletionEvent[]) {
    if (state === 'content' && contentTail) {
      emitContent(events, contentTail)
      contentTail = ''
    } else if (state === 'thinkingFraming' && thinkingFramingTail) {
      emitThinking(events, thinkingFramingTail)
      thinkingFramingTail = ''
    } else if (state === 'toolFraming' && toolFramingTail) {
      toolCallBuffer += toolFramingTail
      toolFramingTail = ''
    } else if (state === 'contentFraming' && contentFramingTail) {
      emitContent(events, contentFramingTail)
      contentFramingTail = ''
    }
  }

  // A frame still open at the end is parsed, or returned as text on error.
  function closeOpenFrames(events: CompletionEvent[], failed: boolean) {
    if (state === 'contentFraming') {
      activeContentFrame = null
    } else if (state === 'toolFraming' && activeToolFrame && !failed) {
      flushToolBuffer(events, false)
    } else if (state === 'toolFraming' && activeToolFrame) {
      const { raw, openedInThinking } = takeToolFrame()
      if (openedInThinking) emitThinking(events, raw)
      else emitContent(events, raw)
    }
  }

  // The turn ended with the calls still held: they were made, unless it failed.
  // Text held after them that is not markup was prose, so they were examples.
  function settleTrailingCalls(events: CompletionEvent[], failed: boolean) {
    if (state === 'afterTool') {
      const tail = afterToolTail
      afterToolTail = ''
      state = 'content'
      const trimmed = tail.trim()
      const markup =
        !trimmed || /^<[|｜]/.test(trimmed) || toolOpeners.some((m) => m.startsWith(trimmed))
      if (failed || !markup) demoteTrailingCalls(events)
      if (!markup) emitContent(events, tail)
    }
    if (failed) demoteTrailingCalls(events)
    else releaseTrailingCalls(events)
  }

  // The turn ended right after a call inside `<think>`: it was made, unless
  // the turn failed. A partial marker buffered after it stays reasoning.
  function settleHeldCalls(events: CompletionEvent[], failed: boolean) {
    if (!heldThinkingCalls) return
    if (failed) {
      emitThinking(events, heldThinkingCalls.raw + afterThinkingToolTail)
      heldThinkingCalls = null
    } else {
      releaseHeldCalls(events)
      if (afterThinkingToolTail.trim()) emitThinking(events, afterThinkingToolTail)
    }
    afterThinkingToolTail = ''
  }

  // The model stopped on its own inside the prompt-opened `<think>`: calls it
  // left there were made, and the reasoning after them, or the whole block
  // when the turn has no call at all, is the answer.
  function promoteOpenThinking(
    events: CompletionEvent[],
    callsLeftInBlock: boolean,
    finalCalls: ToolCall[]
  ) {
    if (contentParts.length > 0) return
    if (callsLeftInBlock) {
      emitContent(events, thinkingParts.slice(undecidedAnswerStart).join('').trim())
    } else if (streamedToolCallKeys.size + finalCalls.length === 0) {
      emitContent(events, thinkingParts.slice(thinkingBlockStart).join('').trim())
    }
  }

  function finish(opts?: {
    stats?: CompletionStats
    toolCalls?: ToolCall[]
    error?: CompletionError
    stopReason?: StopReason
  }): CompletionEvent[] {
    const events: CompletionEvent[] = []
    const failed = !!opts?.error
    const finalCalls = failed ? [] : (opts?.toolCalls ?? [])
    const naturalStop = opts?.stopReason === 'eos' || opts?.stopReason === 'stopSequence'

    drainTails(events)
    closeOpenFrames(events, failed)
    settleTrailingCalls(events, failed)
    settleHeldCalls(events, failed)
    // The block never closed, so every call left in it was made. A cancelled
    // turn says nothing about the ones the model had not confirmed.
    const cancelled = opts?.stopReason === 'cancelled'
    const leftInBlock = failed ? [] : deferredCalls.filter((d) => d.made || !cancelled)
    deferredCalls = []
    for (const { call } of leftInBlock) emitStreamedToolCall(events, call)
    if (activeThinkingFrame === BUILTIN_THINKING && naturalStop && !failed) {
      promoteOpenThinking(events, leftInBlock.length > 0, finalCalls)
    }
    activeThinkingFrame = null
    state = 'content'

    for (const call of finalCalls) emitFinalToolCall(events, call)

    if (opts?.stats) {
      events.push({ type: 'completionStats', seq: nextSeq(), stats: opts.stats })
    }

    const raw = { fullText: rawText }
    if (opts?.error) {
      events.push({
        type: 'completionDone',
        seq: nextSeq(),
        stopReason: 'error',
        error: opts.error,
        raw
      })
    } else if (opts?.stopReason) {
      events.push({ type: 'completionDone', seq: nextSeq(), stopReason: opts.stopReason, raw })
    } else {
      events.push({ type: 'completionDone', seq: nextSeq(), raw })
    }

    return events
  }

  function getAccumulated() {
    return {
      rawText,
      contentText: contentParts.join(''),
      thinkingText: thinkingParts.length > 0 ? thinkingParts.join('') : undefined
    }
  }

  return { push, finish, getAccumulated }
}
