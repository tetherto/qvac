'use strict'

// Single source of truth for benchmark defaults. Every field is
// overridable via CLI flag on run-vlm-bench.js or via workflow_dispatch
// input on the CI workflow. See README §Config Overrides.

module.exports = {
  // ── Sources ──────────────────────────────────────────────────────
  // candidate: the addon as it exists in the working tree (or `npm`
  //   for a published version).
  // baseline: the comparison anchor. 'merge-base' resolves to
  //   `git merge-base HEAD origin/main` at run time. Override with
  //   --baseline-commit=<sha> or set type='skip' to run candidate only.
  sources: {
    candidate: { type: 'addon', source: 'local' },
    baseline: { type: 'addon', source: 'commit', commit: 'merge-base' }
  },

  // ── Model ────────────────────────────────────────────────────────
  // Resolution order in prepare-models.js:
  //   1. --local-model / --local-mmproj (an existing file on disk)
  //   2. registry-server lookup (when QVAC_REGISTRY_URL is set)
  //   3. Hugging Face URL fallback (below)
  model: {
    id: 'qwen3.5-0.8b-q8',
    quant: 'Q8_0',
    llmFile: 'Qwen3.5-0.8B-Q8_0.gguf',
    mmprojFile: 'mmproj-Qwen3.5-0.8B-F16.gguf',
    huggingFace: {
      repo: 'unsloth/Qwen3.5-0.8B-GGUF',
      revision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
      llmFilename: 'Qwen3.5-0.8B-Q8_0.gguf',
      mmprojFilename: 'mmproj-F16.gguf'
    },
    registry: {
      llmId: 'unsloth/Qwen3.5-0.8B-GGUF/Q8_0',
      mmprojId: 'unsloth/Qwen3.5-0.8B-GGUF/mmproj-F16'
    },
    ctxSize: 4096,
    // Qwen3.5 is a reasoning model that emits a <think>...</think>
    // block before its answer; 128 cut us off mid-reasoning. 512 is
    // enough room for the chain-of-thought plus a 7-object answer.
    nPredict: 512
  },

  // ── Case (image + prompt + ground truth) ─────────────────────────
  case: {
    image: 'assets/seven_objects.jpg',
    prompt: 'List only short English object names (comma-separated)',
    groundTruth: [
      // Each entry: { canonical, accepts: [normalised, lowercase, ...] }
      // `accepts` is the plural / alternate-form whitelist (concern 7.3,
      // option b). All entries are matched in lowercase after stripping
      // punctuation and whitespace.
      { canonical: 'Elephant', accepts: ['elephant', 'elephants'] },
      { canonical: 'Umbrella', accepts: ['umbrella', 'umbrellas'] },
      { canonical: 'Submarine', accepts: ['submarine', 'submarines'] },
      { canonical: 'Backpack', accepts: ['backpack', 'backpacks', 'back pack', 'rucksack'] },
      { canonical: 'Windmill', accepts: ['windmill', 'windmills', 'wind mill'] },
      { canonical: 'Cactus', accepts: ['cactus', 'cacti', 'cactuses'] },
      { canonical: 'Helicopter', accepts: ['helicopter', 'helicopters', 'chopper'] }
    ]
  },

  // ── Sampling ─────────────────────────────────────────────────────
  sampling: { temperature: 0, seed: 42 },

  // ── Reasoning mode ───────────────────────────────────────────────
  // Qwen3.5 (and other reasoning models) emit a <think>...</think>
  // chain-of-thought block before the final answer by default. For a
  // fixed-answer benchmark this just burns generated tokens and makes
  // runs ~2x longer for the same final output.
  //
  // The addon's load-time `reasoning-budget` config knob (-1 unrestricted,
  // 0 disabled) wires through to the jinja chat template's
  // `enable_thinking` flag. When thinking.enabled === false the benchmark
  // sets reasoning-budget=0 so the template skips the <think> opener.
  // Override with --thinking=on (or --enable-thinking).
  thinking: { enabled: false },

  // ── Methodology ──────────────────────────────────────────────────
  run: {
    warmupRuns: 1,
    measuredRuns: 3,
    cooldownMs: 5000,
    perRunTimeoutMs: 5 * 60 * 1000
  },

  // ── Platforms / backends (V1 = the running machine only when run
  //    locally; CI matrix overrides via flags). Android backend stays
  //    'auto' in V1 per concern 7.2(c).
  platforms: {
    'macos-arm64': { backends: ['gpu'] },
    'windows-x64': { backends: ['cpu', 'gpu'] },
    'linux-x64': { backends: ['cpu', 'gpu'] },
    android: { backends: ['auto'], device: 'Samsung Galaxy S25 Ultra' },
    ios: { backends: ['gpu'], device: 'iPhone 17' }
  },

  // ── Reporting ────────────────────────────────────────────────────
  reporting: {
    resultsDir: 'results',
    surfaceFullAnswer: true,
    // Qwen3.5 emits <think>...</think> reasoning before the answer; raw
    // responses can be 2-4k chars. 8000 covers the worst observed case
    // with headroom.
    answerTruncChars: 8000
  }
}
