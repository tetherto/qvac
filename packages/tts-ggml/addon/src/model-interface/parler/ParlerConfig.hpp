#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::parler {

// The parler engine's native output rate. Un-enhanced output is tagged with it
// and the streaming enhancer is fed at it, so the model, AddonJs and the
// streaming path can't disagree on the un-enhanced native rate.
// Named to match its Chatterbox counterpart; GlobalConstantCase wants
// UPPER_CASE but the k-prefix is the convention across these headers.
// NOLINTNEXTLINE(readability-identifier-naming)
inline constexpr int kParlerNativeSampleRate = 44100;

/**
 * Voice-description inputs shared by the constructor config and the
 * per-call job input. Either a full free-text `description`, or template
 * fields rendered through tts_cpp::parler::build_description(); setting
 * both at the same level is rejected (mutually exclusive). All-empty is
 * valid and renders the models' recommended fallback caption.
 */
struct ParlerDescriptionFields {
  std::string description;
  std::string voice;
  std::string emotion;      // one of tts_cpp::parler::emotions()
  std::string pitch;        // low | moderate | high
  std::string pace;         // slow | moderate | fast
  std::string expressivity; // monotone | slightly expressive | expressive
  std::string noise;        // clear | noisy
  std::string reverb;       // close | distant
  std::string quality;      // basic | high | very high
};

struct ParlerConfig {
  std::string modelGgufPath;
  ParlerDescriptionFields desc;
  std::optional<int> seed;
  std::optional<int> threads;
  /** Sampling knobs; unset defers to the GGUF's generation defaults. */
  std::optional<float> temperature;
  std::optional<int> topK;
  std::optional<float> topP;
  /** Generation length cap in decoder steps (~86/s); 0 = model default. */
  std::optional<int> maxFrames;
  std::optional<int> minNewTokens;
  /**
   * Desired output sample rate in Hz (8000–192000), or unset/0 to keep the
   * engine's native 44100. The parler engine has no resampler knob, so the
   * addon resamples after synthesis (OutputResampler), or after enhancement
   * when the LavaSR enhancer is active.
   */
  std::optional<int> outputSampleRate;
  /**
   * Native streaming: emit audio in chunks of ~streamChunkTokens decoder steps
   * (~86/s; 43 ~= 0.5 s). 0/unset = whole-utterance batch. Emits at the native
   * 44100 Hz, so combining with a non-native outputSampleRate is rejected
   * unless the LavaSR enhancer is active — StreamingEnhancer resamples inside
   * its own overlap windows, which keeps chunk seams intact.
   */
  std::optional<int> streamChunkTokens;
  std::optional<int> streamFirstChunkTokens;
  /** Digit expansion in the prompt (engine default: enabled). */
  std::optional<bool> normalizeNumbers;
  // GPU offload (Metal on Apple; other backends fall back to CPU). nGpuLayers
  // wins; else useGpu true->99 / false->0. Conflicts rejected in
  // validateConfig.
  std::optional<int> nGpuLayers;
  std::optional<bool> useGpu;
  std::string backendsDir;

  // LavaSR neural speech enhancement. A non-empty `enhancerGgufPath` is the
  // single switch: when set, the model loads the enhancer GGUF and
  // bandwidth-extends the synthesized PCM to 48 kHz before returning it; empty
  // disables enhancement (full backward compat). Parler is natively 44.1 kHz,
  // so the enhancer here buys spectral detail rather than raw bandwidth.
  //
  // The enhancer always produces 48 kHz; if `outputSampleRate` is also set the
  // model resamples the enhanced signal to that rate afterwards. Native
  // streaming enhances per chunk through StreamingEnhancer, which adds ~0.34 s
  // of look-ahead latency.
  std::string enhancerGgufPath;

  // LavaSR neural speech denoiser (UL-UNAS). A non-empty `denoiserGgufPath` is
  // the single switch: when set, the model denoises the synthesized PCM BEFORE
  // the enhancer (rate-preserving); empty disables it (full backward compat).
  // Batch-only: tts-cpp exposes a one-shot denoise(), so combining it with
  // native streaming is rejected in validateConfig.
  std::string denoiserGgufPath;
};

} // namespace qvac::ttsggml::parler
