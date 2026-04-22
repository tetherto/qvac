#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

#include "model-interface/chatterbox/ChatterboxConfig.hpp"

namespace qvac_tts::chatterbox {
class Engine;
} // namespace qvac_tts::chatterbox

namespace qvac::ttsggml::chatterbox {

/**
 * IModel implementation that wraps the qvac-tts::qvac-tts static library
 * (Chatterbox English GGUF).  Holds a persistent
 * `qvac_tts::chatterbox::Engine` so that each {@link process} call pays only
 * the T3 autoregressive decode + S3Gen + HiFT synthesis cost.  The T3 GGUF,
 * S3Gen GGUF, and voice-conditioning tensors are loaded once in {@link load}
 * and reused until {@link unload} / destruction.
 */
class ChatterboxModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  using Input = std::string;
  using InputView = std::string_view;
  using Output = std::vector<int16_t>;

  /**
   * Per-chunk callback used when native streaming is enabled.  Receives
   * each chunk's PCM (already converted to 16-bit) plus its 0-based index
   * and an `isLast` flag.  Wired from the JS binding onto
   * addonCpp->outputQueue so every chunk materialises as an onUpdate
   * event on the JS side (same pattern as qvac-lib-infer-llamacpp-llm's
   * per-token outputCallback).
   */
  using ChunkCallback = std::function<
      void(std::vector<int16_t>&& pcm, int chunkIndex, bool isLast)>;

  struct AnyInput {
    std::string text;
    /** Non-empty = native streaming; empty = batch.  The engine also needs `streamChunkTokens > 0` in its construction config. */
    ChunkCallback chunkCallback;
  };

  explicit ChatterboxModel(ChatterboxConfig config);
  ~ChatterboxModel() noexcept override;

  // IModel
  std::string getName() const override { return "ChatterboxModel"; }
  std::any process(const std::any& input) override;
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;

  // IModelCancel — flips a cancellation flag on the underlying engine; the
  // T3 decode loop checks it per token and throws out of synthesize() on
  // the next iteration.  S3Gen + HiFT is not yet cancellable mid-chunk;
  // that lands with the streaming milestone.
  void cancel() const override;

  void load();
  void unload();
  void reload();
  bool isLoaded() const {
    std::lock_guard lk(engineMu_);
    return static_cast<bool>(engine_);
  }

  void setConfig(ChatterboxConfig config) { cfg_ = std::move(config); }
  const ChatterboxConfig& config() const { return cfg_; }

private:
  Output synthesize(const std::string& text,
                    const ChunkCallback& chunkCallback);
  static void validateConfig(const ChatterboxConfig& cfg);

  // Called under `engineMu_`.
  void loadLocked();
  void unloadLocked();

  ChatterboxConfig cfg_;

  // `engine_` is read by `cancel()` (which can be invoked from any
  // thread) while `load()` / `unload()` / `reload()` mutate it from the
  // job thread — guard both reads and writes with this mutex.  We keep a
  // `shared_ptr` so `cancel()` (and the long-running `synthesize()`) can
  // take a cheap local copy under the lock and then work outside it.
  mutable std::mutex engineMu_;
  std::shared_ptr<qvac_tts::chatterbox::Engine> engine_;

  // Rejects concurrent `process()` invocations; the outer JobRunner also
  // serializes jobs, but belt-and-suspenders enforcement here keeps
  // direct C++ callers honest too.
  std::atomic_bool jobInProgress_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  double tokensPerSecond_ = 0.0;
  size_t textLength_ = 0;

  mutable std::atomic_bool cancelRequested_{false};
};

} // namespace qvac::ttsggml::chatterbox
