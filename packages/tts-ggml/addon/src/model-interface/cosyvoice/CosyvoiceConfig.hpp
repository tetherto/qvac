#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::cosyvoice {

// Native output sample rate (Hz) of CosyVoice3's CausalHiFT vocoder. Shared so
// the model and AddonJs can't disagree on the native rate.
// NOLINTNEXTLINE(readability-identifier-naming)
inline constexpr int kCosyvoiceNativeSampleRate = 24000;

/**
 * Configuration for the CosyVoice3 engine wrapping tts-cpp's CosyVoice3
 * implementation.
 *
 * Maps 1:1 into `tts_cpp::cosyvoice::EngineOptions` via
 * {@link CosyvoiceModel::load} and drives the real CosyVoice3 engine end to
 * end: Qwen2.5 LM (text -> speech tokens) -> DiT conditional-flow-matching
 * (tokens -> mel) -> CausalHiFT vocoder (mel -> 24 kHz PCM), on CPU. Some
 * fields below are plumbed for API stability but are not yet acted on by the
 * engine; those are flagged "reserved / not yet effective" individually.
 */
struct CosyvoiceConfig {
  /**
   * Directory holding the standard CosyVoice3 GGUFs
   * (cosyvoice3-{llm,flow,hift}-*.gguf) plus voice.gguf, vocab.json and
   * merges.txt. Either set this, or set the per-component paths below (explicit
   * paths win).
   */
  std::string modelDir;

  std::string llmModelPath;   // Qwen2.5 LM (text -> speech tokens)
  std::string flowModelPath;  // DiT conditional-flow-matching (tokens -> mel)
  std::string hiftModelPath;  // CausalHiFT vocoder (mel -> 24 kHz PCM)
  std::string s3tokModelPath; // supervised S3 speech tokenizer (zero-shot)
  std::string campplusModelPath; // CAM++ speaker encoder (zero-shot)

  /**
   * Zero-shot voice cloning: reference wav + its transcript. RESERVED / not
   * yet effective — the native path needs the S3 speech tokenizer + CAM++
   * speaker encoder, which are not ported yet; the engine warns and falls back
   * to the baked voice. Plumbed for API stability.
   */
  std::string referenceAudio;
  std::string promptText;
  /**
   * A voice baked into voices.gguf (reference audio wins when both set).
   * RESERVED / not yet effective — named-voice selection is not yet wired in
   * the engine. Plumbed for API stability.
   */
  std::string voice;

  /**
   * Natural-language control instruction (CosyVoice3 instruct2): selects a
   * Chinese dialect, emotion, speaking speed, volume, or style. The JS layer
   * renders a structured `instruct` (e.g. { dialect: 'cantonese' }) into the
   * trained instruction string ("请用广东话表达。") before it reaches here;
   * the engine wraps it as "You are a helpful assistant. " + instruct +
   * "<|endofprompt|>" and drops the LM prompt speech tokens. Empty = zero-shot.
   */
  std::string instruct;

  /**
   * Language hint for the multilingual text frontend. RESERVED / not yet
   * effective — the text-normalization frontend is not yet integrated, so this
   * is accepted but not acted on. Plumbed for API stability.
   */
  std::string language = "en";

  std::optional<int> seed;
  /** std::thread::hardware_concurrency() override. */
  std::optional<int> threads;
  /** Layers to move to the GPU backend. Iteration 1 is CPU-only (ignored). */
  std::optional<int> nGpuLayers;
  /**
   * Tri-state GPU intent (mirrors ChatterboxConfig::useGpu). Iteration 1 runs
   * CPU-only, but the field is plumbed and conflict-checked so the option
   * surface matches the sibling engines. Conflicts with nGpuLayers (true + 0,
   * or false + !=0) are rejected by CosyvoiceModel::validateConfig.
   */
  std::optional<bool> useGpu;
  /**
   * Desired output sample rate in Hz (8000–192000), or unset/0 to keep the
   * engine's native 24 kHz. When the LavaSR enhancer is active the enhancer
   * emits 48 kHz and the addon resamples to this value afterwards (batch), or
   * folds it into the seam-free streaming window (native chunk streaming).
   */
  std::optional<int> outputSampleRate;
  /**
   * Flow-matching Euler steps. RESERVED / not yet effective — the engine runs
   * a fixed 10-step schedule and currently ignores this value. Plumbed for API
   * stability.
   */
  std::optional<int> cfmSteps;

  /**
   * Streaming controls. When `streamChunkTokens > 0` and the job passes a chunk
   * callback, the engine emits PCM progressively in per-chunk hops. NOTE: the
   * engine currently computes the full audio and then slices it into chunks, so
   * chunks are emitted progressively but first-audio latency is NOT yet reduced
   * (true token2wav low-latency streaming is reserved in tts-cpp). 0 = batch
   * synthesis.
   */
  std::optional<int> streamChunkTokens;
  /** Smaller first chunk for low first-audio latency. 0 = same as
   * streamChunkTokens. */
  std::optional<int> streamFirstChunkTokens;
  /** Left context carried into each chunk (bounds per-chunk cost). */
  std::optional<int> streamLeftContextTokens;

  /** Forwarded to `tts_cpp::cosyvoice::EngineOptions::backends_dir`. */
  std::string backendsDir;

  // Bandwidth-extends the native 24 kHz output to 48 kHz, on both the batch
  // path and native chunk streaming. Empty disables enhancement.
  std::string enhancerGgufPath;

  // Denoises the synthesized PCM before the enhancer, rate-preserving. Empty
  // disables it. Batch-only: tts-cpp exposes a one-shot denoise(), so
  // CosyvoiceModel::validateConfig rejects it with native chunk streaming.
  std::string denoiserGgufPath;
};

} // namespace qvac::ttsggml::cosyvoice
