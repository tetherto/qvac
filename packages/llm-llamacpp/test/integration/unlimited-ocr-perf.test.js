'use strict'
// Unlimited-OCR document-parsing perf row. Records encode / prefill / decode
// timings (from response.stats) on a real scanned document, so the weekly
// vlmPerf suite reports throughput for this OCR VLM the same way it does for
// Gemma4-VL / Qwen3.5-VL. One image per file to stay under the 30-minute
// Device Farm cap.

const test = require('brittle')
const { runVlmImagePerf, isDarwinX64 } = require('./_vlm-image-perf.js')

// Same GGUFs as the functional ocr-unlimited test (pinned community conversion).
const UNLIMITED_OCR_MODEL = {
  perfLabel: 'unlimited-ocr',
  llmModel: {
    modelName: 'unlimited-ocr-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/vimalnakrani/unlimited-ocr-gguf/resolve/45cd66ec6b46a7c4de49f376084ecec2b8d3c59a/unlimited-ocr-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-unlimited-ocr-F16.gguf',
    downloadUrl:
      'https://huggingface.co/vimalnakrani/unlimited-ocr-gguf/resolve/45cd66ec6b46a7c4de49f376084ecec2b8d3c59a/mmproj-unlimited-ocr-F16.gguf'
  },
  // Cap generation and apply a repetition penalty: under pure greedy the OCR
  // decoder can degenerate and generate past the context window, so an unbounded
  // run would overflow. predict bounds each run; repeat_penalty lets it terminate
  // naturally for a representative throughput number.
  extraConfig: { predict: '1024', repeat_penalty: '1.3' },
  ctxFor: () => '8192'
}

// Document case: the model emits a full-page parse, so we assert on radiology
// keywords rather than a caption, and use Unlimited-OCR's task prompt.
const CT_SCAN_CASE = {
  name: 'ct-scan',
  imageFile: 'ct-scan-report.png',
  prompt: 'document parsing.',
  keywords: ['tomography', 'chest', 'abdomen', 'gallbladder', 'pancreas']
}

test(
  'Unlimited-OCR document perf [ct-scan]',
  { timeout: 1_800_000, skip: isDarwinX64 },
  async (t) => {
    await runVlmImagePerf(t, UNLIMITED_OCR_MODEL, CT_SCAN_CASE)
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
