#pragma once
#include <any>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "model-interface/pocket/PocketConfig.hpp"

namespace qvac::ttsggml::pocket {
class PocketModel : public qvac_lib_inference_addon_cpp::model::IModel,
                    public qvac_lib_inference_addon_cpp::model::IModelCancel,
                    public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Output = std::vector<int16_t>;
  // Streaming sends PCM immediately, then an empty isLast=true marker on success.
  using ChunkCallback = std::function<void(Output&&, int, bool)>;
  struct AnyInput { std::string text; ChunkCallback chunkCallback; };
  explicit PocketModel(PocketConfig config);
  ~PocketModel() noexcept override = default;
  std::string getName() const override { return "PocketModel"; }
  std::any process(const std::any& input) override;
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;
  void cancel() const override;
  void load();
  void unload();
  void reload(PocketConfig config);
  bool isLoaded() const;
  int sampleRate() const { return sampleRate_; }
  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}
private:
  PocketConfig cfg_;
  const int sampleRate_;
  mutable std::mutex mutex_;
  std::shared_ptr<tts_cpp::pocket::Engine> engine_;
  std::atomic_bool busy_{false};
  mutable std::atomic<uint64_t> cancelEpoch_{0};
  qvac_lib_inference_addon_cpp::RuntimeStats stats_;
};
}
