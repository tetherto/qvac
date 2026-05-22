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
  // The benchmark has TWO model sources of the same family. The
  // candidate source is always downloaded and benchmarked. The
  // baseline source is only used when `--compare-baseline` is set
  // (orchestrator) / `compare_baseline=true` (workflow input).
  //
  // Default configuration is a Q8_0-vs-Q4_K_M compare of the same
  // unsloth Qwen3.5-0.8B-GGUF repo at the same pinned revision —
  // guaranteed-different binaries (different filesize and memory
  // traffic) and a real perf delta to validate the verdict pipeline.
  // The two model files share the same `mmproj-F16.gguf` so the
  // vision encoder cost is constant; only the LLM quant differs.
  //
  // Swap to a true different-source compare any time by repointing
  // baseline.url at a different HF repo + revision (e.g. an alternate
  // quantizer's GGUF), provided their mmproj is also compatible.
  model: {
    id: 'qwen3.5-0.8b',
    ctxSize: 4096,
    // Qwen3.5 is a reasoning model; 128 tokens cut off mid-CoT, so
    // give it 512 — enough for the chain-of-thought plus a 7-object
    // answer when reasoning is on.
    nPredict: 512,
    // Convention: baseline is the heavier / reference build, candidate
    // is the proposed lighter build under test. The verdict reads
    // "candidate vs baseline", so the candidate "winning" (lower wall
    // / higher TPS) shows as "better".
    candidate: {
      label: 'unsloth-Q4_K_M',
      quant: 'Q4_K_M',
      hfRepo: 'unsloth/Qwen3.5-0.8B-GGUF',
      hfRevision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
      llmFile: 'Qwen3.5-0.8B-Q4_K_M--cand.gguf',
      mmprojFile: 'mmproj-Qwen3.5-0.8B-F16--cand.gguf',
      url: {
        llm: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q4_K_M.gguf',
        mmproj: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/mmproj-F16.gguf'
      }
    },
    baseline: {
      label: 'unsloth-Q8_0',
      quant: 'Q8_0',
      hfRepo: 'unsloth/Qwen3.5-0.8B-GGUF',
      hfRevision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
      llmFile: 'Qwen3.5-0.8B-Q8_0--base.gguf',
      mmprojFile: 'mmproj-Qwen3.5-0.8B-F16--base.gguf',
      url: {
        llm: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q8_0.gguf',
        mmproj: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/mmproj-F16.gguf'
      }
    }
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
