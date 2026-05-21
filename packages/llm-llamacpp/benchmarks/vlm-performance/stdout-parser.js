'use strict'

// Parses metrics from the addon's stdout/stderr stream. These lines are
// emitted by llama.cpp/llama-mtmd at info-or-higher verbosity; the
// benchmark runs the addon with config.verbosity='2' to keep them in
// the captured stream. If the addon ever stops surfacing these lines
// at the JS layer, surface a `visionEncodeMs` field on stats instead.

const VISION_ENCODE_REGEX = /image (?:slice )?encoded in\s+(\d+(?:\.\d+)?)\s*ms/i
// Pulled verbatim from Ian's Metal plan §5.7 — same llama.cpp output
// shape on every platform.
const EVAL_TIME_REGEX = /(?:llama_perf_context_print:\s*)?eval time\s*=\s*(\d+(?:\.\d+)?)\s*ms\s*\/\s*(\d+)\s+(?:tokens|runs)\s*\((\d+(?:\.\d+)?)\s+tokens per second\)/i
const PROMPT_EVAL_REGEX = /prompt eval time\s*=\s*(\d+(?:\.\d+)?)\s*ms\s*\/\s*(\d+)\s+tokens/i
const LOAD_TIME_REGEX = /load time\s*=\s*(\d+(?:\.\d+)?)\s*ms/i
const TOTAL_TIME_REGEX = /total time\s*=\s*(\d+(?:\.\d+)?)\s*ms/i

function parseStdoutMetrics (text) {
  if (!text) return {}
  const out = {}

  const vis = text.match(VISION_ENCODE_REGEX)
  if (vis) out.visionEncodeMs = Number(vis[1])

  const prompt = text.match(PROMPT_EVAL_REGEX)
  if (prompt) {
    out.promptEvalMs = Number(prompt[1])
    out.promptTokens = Number(prompt[2])
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
