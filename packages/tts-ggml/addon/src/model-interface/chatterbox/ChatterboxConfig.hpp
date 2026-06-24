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
  /**
   * T3 context-length cap, forwarded to
   * `tts_cpp::chatterbox::EngineOptions::n_ctx` (the engine clamps the
   * GGUF's own n_ctx to this; it never raises it).
   *
   * The T3 KV cache is allocated UP-FRONT at n_ctx, in F32: the Turbo
   * GGUF ships n_ctx=8196 which costs ~1.6 GB of KV for synthesis that
   * rarely needs more than a few hundred tokens (QVAC-19557 iOS OOM).
   * When unset, {@link ChatterboxModel} applies kDefaultNCtx (2048,
   * ~400 MB KV on Turbo, ≈80 s of audio per synthesize() call).
   *
   *   - unset:  kDefaultNCtx (4096)
   *   - > 0:    explicit cap (prompt + generated speech tokens)
   *   - 0:      escape hatch — no cap, use the GGUF's full n_ctx
   *   - < 0:    rejected by validateConfig
   */
  std::optional<int> nCtx;
  /**
   * T3 KV-cache storage type, forwarded to
   * `tts_cpp::chatterbox::EngineOptions::kv_cache_type`:
   * "f32" | "f16" | "q8_0".  The cache is allocated up-front at nCtx,
   * so the dtype directly scales resident memory — q8_0 stores it at
   * ~27% of f32 (one fp16 scale per 32 values).  Upstream validation
   * (qvac-ext-lib-whisper.cpp#43): greedy token sequences are
   * byte-identical across all three dtypes on the Turbo model
   * (CPU + Metal), and Metal decode gets 20-30% FASTER from the
   * bandwidth saving.  Empty/unset -> {@link ChatterboxModel}'s
   * kDefaultKvCacheType ("q8_0"); anything outside the three values
   * is rejected by validateConfig.
   */
  std::string kvCacheType;
  /** Post-processing output sample rate.  Currently unused (engine always emits 24 kHz). */
  std::optional<int> outputSampleRate;
  /**
   * Speaking-rate multiplier (a duration multiplier, mirroring Supertonic's
   * `speed`):  outputDuration = synthesizedDuration / speed.  `speed < 1`
   * slows speech down, `> 1` speeds it up.
   *
   * Unset (or 1.0) leaves the raw model output unchanged — no rate control is
   * applied by default, for backward compatibility.  Callers opt in by passing
   * an explicit value.
   *
   * Unlike Supertonic — which scales a native duration predictor inside the
   * engine — Chatterbox's engine exposes no speaking-rate control (its S3
   * speech tokens run at a fixed 25 Hz and duration is emergent from the
   * autoregressive T3).  So this is applied as a post-synthesis,
   * pitch-preserving WSOLA time-stretch on the 24 kHz PCM (see
   * {@link WsolaTimeStretch}), functionally equivalent to ffmpeg's `atempo`.
   *
   * Must be > 0; bounded to [0.25, 4.0] by ChatterboxModel::validateConfig.
   */
  std::optional<float> speed;
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
