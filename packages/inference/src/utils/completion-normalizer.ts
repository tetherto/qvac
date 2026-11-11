import type {
  CompletionEvent,
  CompletionError,
  CompletionStats,
  NormalizerConfig,
  StopReason,
  ToolCall
} from '@/schemas/index'
import { parseToolCalls } from '@/utils/tools/index'

type NormalizerState =
  'content' | 'thinkingFraming' | 'toolFraming' | 'contentFraming' | 'afterThinkingTool'

type FrameSpec = {
  open: string
  close: string
}

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
}

type Dialect = NonNullable<NormalizerConfig['toolDialect']>

const DSML_INVOKE_FRAMES: readonly FrameSpec[] = [' ', '\n', '\t', '\r'].map((sep) => ({
  open: `<｜DSML｜invoke${sep}`,
  close: '</｜DSML｜invoke>'
}))

const DIALECT_SPECS: Record<Dialect, DialectSpec> = {
  hermes: {
    toolFrames: [{ open: '<tool_call>', close: '</tool_call>' }]
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
    contentDropTokens: ['<|channel|>']
  },
  qwen35: {
    // Same <tool_call>…</tool_call> framing as hermes; inner content is XML.
    toolFrames: [{ open: '<tool_call>', close: '</tool_call>' }]
  },
  gemma4: {
    toolFrames: [{ open: '<|tool_call>', close: '<tool_call|>' }],
    thinkingFrames: [{ open: '<|channel>thought', close: '<channel|>' }]
  },
  dsml: {
    toolFrames: [
      { open: '<｜DSML｜tool_calls>', close: '</｜DSML｜tool_calls>' },
      { open: '<｜DSML｜function_calls>', close: '</｜DSML｜function_calls>' },
      ...DSML_INVOKE_FRAMES
    ]
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
  // Calls in the current block that were followed by more reasoning. They were
  // quoted if the block closes, and made if the turn ends with it still open.
  let undecidedCalls: ToolCall[] = []
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

  function emitFinalToolCall(events: CompletionEvent[], call: ToolCall) {
    const key = getToolCallKey(call)
    if (streamedToolCallKeys.has(key)) return
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

  function flushToolBuffer(events: CompletionEvent[], closed: boolean) {
    const { raw, frame, openedInThinking } = takeToolFrame()

    if (!frame) return

    // The reasoning only mentioned the marker: still inside `<think>`.
    function returnToThinking() {
      trimThinkingStart = false
      emitThinking(events, raw)
      activeThinkingFrame = BUILTIN_THINKING
      if (closed) state = 'thinkingFraming'
    }

    // Empty-payload guard. Strip frame markers and check the inner is
    // non-empty; surface a toolError on empty payloads so the literal
    // markers don't leak into contentDelta.
    let inner = raw
    if (inner.startsWith(frame.open)) inner = inner.slice(frame.open.length)
    if (inner.endsWith(frame.close)) {
      inner = inner.slice(0, inner.length - frame.close.length)
    }
    if (inner.trim().length === 0) {
      if (openedInThinking) return returnToThinking()
      events.push({
        type: 'toolError',
        seq: nextSeq(),
        error: { code: 'PARSE_ERROR', message: 'Empty tool_call frame' }
      })
      return
    }

    const { toolCalls, errors } = parseToolCalls(raw, config.tools, dialect)

    if (openedInThinking) {
      if (toolCalls.length === 0) return returnToThinking()
      if (closed) {
        heldThinkingCalls = { raw, calls: toolCalls }
        state = 'afterThinkingTool'
        return
      }
    }

    for (const call of toolCalls) emitStreamedToolCall(events, call)

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
    const { raw } = takeToolFrame()
    state = 'content'

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
    }
  }

  // Each step consumes what it can of `buf` in the current state and returns the rest.
  function stepToolFraming(events: CompletionEvent[], buf: string) {
    if (!activeToolFrame) {
      state = 'content'
      return buf
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
      closeThinkingBlock()
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

  function closeThinkingBlock() {
    undecidedCalls = []
    activeThinkingFrame = null
    trimAfterThinking = contentParts.length === 0
    state = 'content'
  }

  function releaseHeldCalls(events: CompletionEvent[]) {
    const held = heldThinkingCalls
    heldThinkingCalls = null
    for (const call of held?.calls ?? []) emitStreamedToolCall(events, call)
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
        closeThinkingBlock()
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
    undecidedCalls.push(...(held?.calls ?? []))
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
      closeThinkingBlock()
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

    while (buf.length > 0) {
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
          undecidedCalls = []
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

  function finish(opts?: {
    stats?: CompletionStats
    toolCalls?: ToolCall[]
    error?: CompletionError
    stopReason?: StopReason
  }): CompletionEvent[] {
    const events: CompletionEvent[] = []

    // Drain pending tail bytes so we don't lose trailing chars when the
    // stream ends mid-marker.
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
      // Cutoff inside a partial close marker — emit tail as content.
      emitContent(events, contentFramingTail)
      contentFramingTail = ''
    }

    if (state === 'toolFraming' && activeToolFrame) {
      if (opts?.error) {
        const { raw, openedInThinking } = takeToolFrame()
        if (openedInThinking) emitThinking(events, raw)
        else emitContent(events, raw)
      } else {
        flushToolBuffer(events, false)
      }
    } else if (state === 'contentFraming') {
      activeContentFrame = null
    }
    if (heldThinkingCalls) {
      if (opts?.error) {
        emitThinking(events, heldThinkingCalls.raw)
        heldThinkingCalls = null
      } else {
        releaseHeldCalls(events)
      }
    }
    // The model stopped on its own inside the prompt-opened `<think>`: calls it
    // left there were made, and the reasoning after them, or the whole block
    // when there are none, is the answer.
    const naturalStop = opts?.stopReason === 'eos' || opts?.stopReason === 'stopSequence'
    if (activeThinkingFrame === BUILTIN_THINKING && !opts?.error && naturalStop) {
      const hadCalls = streamedToolCallKeys.size > 0 || !!opts?.toolCalls?.length
      const answerStart = undecidedCalls.length > 0 ? undecidedAnswerStart : thinkingBlockStart
      for (const call of undecidedCalls) emitStreamedToolCall(events, call)
      if (contentParts.length === 0 && (undecidedCalls.length > 0 || !hadCalls)) {
        emitContent(events, thinkingParts.slice(answerStart).join('').trim())
      }
    }
    undecidedCalls = []
    activeThinkingFrame = null
    state = 'content'

    if (!opts?.error) {
      if (opts?.toolCalls) {
        for (const call of opts.toolCalls) {
          emitFinalToolCall(events, call)
        }
      }
    }

    if (opts?.stats) {
      events.push({
        type: 'completionStats',
        seq: nextSeq(),
        stats: opts.stats
      })
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
      events.push({
        type: 'completionDone',
        seq: nextSeq(),
        stopReason: opts.stopReason,
        raw
      })
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
