#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::cosyvoice {

/**
 * Configuration for the CosyVoice3 engine wrapping tts-cpp::tts-cpp.
 *
 * ITERATION 1 (SCAFFOLD): maps 1:1 into `tts_cpp::cosyvoice::EngineOptions`
 * via {@link CosyvoiceModel::load}. The underlying tts-cpp engine is the
 * wiring skeleton — synthesize() returns placeholder audio until the real CPU
 * graphs (Qwen2 LM -> S3 tokenizer -> DiT flow -> HiFT vocoder) land. The
 * option surface here is intended to stay stable across that work.
 */
struct CosyvoiceConfig {
  /**
   * Directory holding the standard CosyVoice3 GGUFs
   * (cosyvoice3-{llm,flow,hift,s3tok,campplus,voices}-*.gguf). Either set
   * this, or set the per-component paths below (explicit paths win).
   */
  std::string modelDir;

  std::string llmModelPath;       // Qwen2.5 LM (text -> speech tokens)
  std::string flowModelPath;      // DiT conditional-flow-matching (tokens -> mel)
  std::string hiftModelPath;      // CausalHiFT vocoder (mel -> 24 kHz PCM)
  std::string s3tokModelPath;     // supervised S3 speech tokenizer (zero-shot)
  std::string campplusModelPath;  // CAM++ speaker encoder (zero-shot)

  /** Zero-shot voice cloning: reference wav + its transcript. */
  std::string referenceAudio;
  std::string promptText;
  /** Or a voice baked into voices.gguf (reference audio wins when both set). */
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

  /** Language hint for the multilingual text frontend. */
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
   * engine's native 24 kHz.
   */
  std::optional<int> outputSampleRate;
  /** Flow-matching Euler steps. Unset/0 = model default (10). */
  std::optional<int> cfmSteps;

  /**
   * Native streaming controls. CosyVoice3 is a token-by-token streaming model
   * (the LM emits speech tokens, token2wav vocodes them in hops). When
   * `streamChunkTokens > 0` and the job passes a chunk callback, the engine
   * runs the chunked loop and emits PCM per chunk. 0 = batch synthesis.
   */
  std::optional<int> streamChunkTokens;
  /** Smaller first chunk for low first-audio latency. 0 = same as streamChunkTokens. */
  std::optional<int> streamFirstChunkTokens;
  /** Left context carried into each chunk (bounds per-chunk cost). */
  std::optional<int> streamLeftContextTokens;

  /** Forwarded to `tts_cpp::cosyvoice::EngineOptions::backends_dir`. */
  std::string backendsDir;
};

} // namespace qvac::ttsggml::cosyvoice
