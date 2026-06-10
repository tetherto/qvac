'use strict'

// Parses metrics from the addon's stdout/stderr stream. These lines are
// emitted by llama.cpp/llama-mtmd at info-or-higher verbosity; the
// benchmark runs the addon with config.verbosity='2' to keep them in
// the captured stream. If the addon ever stops surfacing these lines
// at the JS layer, surface a `visionEncodeMs` field on stats instead.

// Use /g + matchAll so we sum across every "image slice encoded" line
// llama.cpp emits — dynamic-resolution VLMs (Qwen-VL, InternVL, etc.)
// emit one line per tile, and reporting just the first one undercounts
// the actual encoder workload. visionEncodeSliceCount surfaces the
// tile count so it shows up in the report alongside the summed time.
const VISION_ENCODE_REGEX = /image (?:slice )?encoded in\s+(\d+(?:\.\d+)?)\s*ms/gi
// Pulled verbatim from Ian's Metal plan §5.7 — same llama.cpp output
// shape on every platform.
// Prompt eval must be matched BEFORE decode eval since "prompt eval time"
// contains "eval time". The prompt regex is anchored with "prompt" prefix;
// the decode regex uses a negative lookbehind to skip "prompt eval" lines.
const PROMPT_EVAL_REGEX = /prompt eval time\s*=\s*(\d+(?:\.\d+)?)\s*ms\s*\/\s*(\d+)\s+tokens\s*\([^)]*?(\d+(?:\.\d+)?)\s+tokens per second\)/i
const EVAL_TIME_REGEX = /(?<!prompt )eval time\s*=\s*(\d+(?:\.\d+)?)\s*ms\s*\/\s*(\d+)\s+(?:tokens|runs)\s*\([^)]*?(\d+(?:\.\d+)?)\s+tokens per second\)/i
const LOAD_TIME_REGEX = /load time\s*=\s*(\d+(?:\.\d+)?)\s*ms/i
const TOTAL_TIME_REGEX = /total time\s*=\s*(\d+(?:\.\d+)?)\s*ms/i

function parseStdoutMetrics (text) {
  if (!text) return {}
  const out = {}

  const visMatches = [...text.matchAll(VISION_ENCODE_REGEX)]
  if (visMatches.length) {
    out.visionEncodeMs = visMatches.reduce((sum, m) => sum + Number(m[1]), 0)
    out.visionEncodeSliceCount = visMatches.length
  }

  const prompt = text.match(PROMPT_EVAL_REGEX)
  if (prompt) {
    out.promptEvalMs = Number(prompt[1])
    out.promptTokens = Number(prompt[2])
    if (prompt[3]) out.promptTps = Number(prompt[3])
  }

  const eval_ = text.match(EVAL_TIME_REGEX)
  if (eval_) {
    out.decodeMs = Number(eval_[1])
    out.decodeTokens = Number(eval_[2])
    out.decodeTps = Number(eval_[3])
  }

  const load = text.match(LOAD_TIME_REGEX)
  if (load) out.loadMs = Number(load[1])

  const total = text.match(TOTAL_TIME_REGEX)
  if (total) out.totalMs = Number(total[1])

  return out
}

module.exports = { parseStdoutMetrics }
