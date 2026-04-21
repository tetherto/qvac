#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

#include "model-interface/chatterbox/ChatterboxConfig.hpp"

namespace qvac::ttsggml::chatterbox {

/**
 * IModel implementation that wraps the qvac-tts::qvac-tts static library
 * (Chatterbox English GGUF).  This first iteration drives the engine by
 * assembling argv and calling `qvac_tts_cli_main` — the end-to-end CLI path
 * — then reading the generated wav back into memory.  Consequence: every
 * {@link process} call re-loads the full model (~700 ms + inference time),
 * and streaming is not exposed yet.  The follow-up milestone replaces this
 * with a persistent, struct-based API once qvac-tts.cpp exposes one.
 */
class ChatterboxModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  using Input = std::string;
  using InputView = std::string_view;
  using Output = std::vector<int16_t>;
  using JobConfig = std::unordered_map<std::string, std::string>;

  struct AnyInput {
    std::string text;
    /** Per-request config overrides (outputSampleRate, …); same string-map shape as the base config. */
    JobConfig config;
  };

  explicit ChatterboxModel(ChatterboxConfig config);
  ~ChatterboxModel() noexcept override = default;

  // IModel
  std::string getName() const override { return "ChatterboxModel"; }
  std::any process(const std::any& input) override;
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;

  // IModelCancel — best-effort: the argv-based CLI entry point can't be
  // interrupted mid-synthesis, so cancellation only short-circuits
  // subsequent process() calls.  Proper cancellation lands alongside the
  // streaming API.
  void cancel() const override;

  void load();
  void unload();
  void reload();
  bool isLoaded() const { return loaded_; }

  void setConfig(ChatterboxConfig config) { cfg_ = std::move(config); }
  const ChatterboxConfig& config() const { return cfg_; }

private:
  Output synthesize(const std::string& text, const JobConfig& perRequestOverrides);
  static void validatePaths(const ChatterboxConfig& cfg);

  ChatterboxConfig cfg_;
  bool loaded_ = false;

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  double tokensPerSecond_ = 0.0;
  size_t textLength_ = 0;

  mutable std::atomic_bool cancelRequested_{false};
};

} // namespace qvac::ttsggml::chatterbox
