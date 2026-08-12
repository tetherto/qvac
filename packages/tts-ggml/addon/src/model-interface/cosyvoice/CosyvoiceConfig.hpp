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
 * (tokens -> mel) -> CausalHiFT vocoder (mel -> 24 kHz PCM), on CPU or, when
 * nGpuLayers/useGpu request it, tts-cpp's OpenCL/Adreno GPU path. Some fields
 * below are plumbed for API stability but are not yet acted on by the engine;
 * those are flagged "reserved / not yet effective" individually.
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
   * Canonical cross-engine conditioning (see tts-cpp/voice_controls.h). The
   * engine maps these to the trained instructions; only "moderate" engages
   * nothing, taking the zero-shot path.
   */
  std::string emotion;
  std::string pace;

  /**
   * Raw instruction for the controls with no canonical vocabulary yet (dialect
   * / volume / style). The JS layer renders a structured `instruct` (e.g.
   * { dialect: 'cantonese' }) into the trained sentence ("请用广东话表达。")
   * before it reaches here. CosyVoice3 takes one instruction per synthesis, so
   * engaging this alongside emotion/pace throws.
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
  /**
   * Layers to move to the GPU backend. 0 keeps CPU; >0 selects tts-cpp's GPU
   * path, currently implemented on OpenCL/Adreno (Android) only, falling back
   * to CPU where no GPU device is usable. Forwarded to
   * EngineOptions::n_gpu_layers.
   */
  std::optional<int> nGpuLayers;
  /**
   * Tri-state GPU intent (mirrors ChatterboxConfig::useGpu). true offloads all
   * layers, false pins CPU; the engine honors it on the OpenCL/Adreno GPU path
   * and falls back to CPU otherwise. Conflicts with nGpuLayers (true + 0, or
   * false + !=0) are rejected by CosyvoiceModel::validateConfig.
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
  /**
   * Left context intended to bound per-chunk cost. RESERVED / not yet effective
   * — the pinned tts-cpp engine accepts but does not read
   * stream_left_context_tokens; plumbed for API stability.
   */
  std::optional<int> streamLeftContextTokens;

  /** Forwarded to `tts_cpp::cosyvoice::EngineOptions::backends_dir`. */
  std::string backendsDir;

  /**
   * Forwarded to `tts_cpp::cosyvoice::EngineOptions::opencl_cache_dir`: a
   * writable directory for ggml-opencl's compiled program-binary cache. Only
   * consumed on the Android OpenCL/Adreno GPU path (nGpuLayers/useGpu > 0);
   * empty leaves ggml's default. Dropping it makes every process recompile the
   * OpenCL kernels from scratch.
   */
  std::string openclCacheDir;

  // Bandwidth-extends the native 24 kHz output to 48 kHz, on both the batch
  // path and native chunk streaming. Empty disables enhancement.
  std::string enhancerGgufPath;

  // Denoises the synthesized PCM before the enhancer, rate-preserving. Empty
  // disables it. Batch-only: tts-cpp exposes a one-shot denoise(), so
  // CosyvoiceModel::validateConfig rejects it with native chunk streaming.
  std::string denoiserGgufPath;
};

} // namespace qvac::ttsggml::cosyvoice
