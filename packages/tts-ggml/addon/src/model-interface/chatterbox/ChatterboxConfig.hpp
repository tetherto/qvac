#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::chatterbox {

/**
 * Configuration for the Chatterbox engine wrapping tts-cpp::tts-cpp.
 *
 * Mapped 1:1 into `tts_cpp::chatterbox::EngineOptions` by
 * {@link ChatterboxModel::load} and then passed to a persistent Engine that
 * owns the T3 + S3Gen + voice-conditioning state for the lifetime of the
 * addon.  The Engine is re-created on reload() when any of these fields
 * change (ex: a new reference voice or a flip between CPU / GPU).
 */
struct ChatterboxConfig {
  /** Path to the T3 (text -> speech tokens) GGUF. */
  std::string t3ModelPath;
  /** Path to the S3Gen + HiFT (speech tokens -> 24 kHz wav) GGUF. */
  std::string s3genModelPath;
  /** Language code; only "en" is supported by the current Chatterbox model. */
  std::string language = "en";
  /** Voice-cloning reference wav path. */
  std::string referenceAudio;
  /** Directory of baked voice-conditioning tensors (`tts-cpp --ref-dir`). */
  std::string voiceDir;
  /** RNG seed for CFM initial noise + SineGen excitation. */
  std::optional<int> seed;
  /** std::thread::hardware_concurrency() override. */
  std::optional<int> threads;
  /** Layers to move to the GPU backend.  99 (or any large number) = all. */
  std::optional<int> nGpuLayers;
  /** Post-processing output sample rate.  Currently unused (engine always emits 24 kHz). */
  std::optional<int> outputSampleRate;
  /**
   * Tri-state GPU intent:
   *   - std::nullopt: unspecified, let the engine use its library default.
   *   - true:         if nGpuLayers unset, maps to nGpuLayers=99.
   *   - false:        if nGpuLayers unset, forces nGpuLayers=0 (CPU).
   *
   * Conflicts with nGpuLayers (true + 0, or false + !=0) are rejected
   * by ChatterboxModel::validateConfig so callers can't silently get
   * the opposite backend they asked for.
   */
  std::optional<bool> useGpu;
  /**
   * Native streaming controls.  When `streamChunkTokens > 0` and the
   * caller passes a chunk callback on the job input, the engine runs
   * the chunked S3Gen+HiFT loop and emits PCM per chunk (~25 tokens
   * = 1 s of audio).  0 = batch synthesis.
   */
  std::optional<int> streamChunkTokens;
  /** Smaller first chunk for low first-audio-out latency.  0 = same as streamChunkTokens. */
  std::optional<int> streamFirstChunkTokens;
  /** CFM Euler steps for streaming chunks.  0 = library default (2). */
  std::optional<int> streamCfmSteps;

  /**
   * Forwarded to `tts_cpp::chatterbox::EngineOptions::backends_dir` /
   * `opencl_cache_dir`.
   */
  std::string backendsDir;
  std::string openclCacheDir;

  /**
   * Multilingual text preprocessing dictionaries (multilingual variant
   * only; ignored by the Turbo English GGUF).  The actual MeCab /
   * Cangjie segmentation happens inside tts-cpp; the addon just forwards
   * the host-resolved paths into
   * `tts_cpp::chatterbox::EngineOptions::mecab_dict_path` /
   * `cangjie_tsv_path`.
   *
   *   mecabDictPath:  directory holding the compiled IPAdic dictionary
   *                   (char.bin, dicrc, matrix.bin, mecabrc, sys.dic,
   *                   unk.dic).  Required for Japanese ("ja"); when empty
   *                   tts-cpp falls back to character-level handling and
   *                   kanji degrade to [UNK].
   *
   *   cangjieTsvPath: Cangjie hanzi->code TSV used for Chinese ("zh").
   *                   zh is currently excluded from the multilingual
   *                   tokenizer's supported_languages(), so this stays
   *                   wired but unused until the Cangjie path is reworked.
   *
   * Empty -> leave the corresponding EngineOptions field empty.
   */
  std::string mecabDictPath;
  std::string cangjieTsvPath;
};

} // namespace qvac::ttsggml::chatterbox
