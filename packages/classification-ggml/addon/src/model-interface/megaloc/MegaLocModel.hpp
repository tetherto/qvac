#pragma once

#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "model-interface/ImageInput.hpp"

namespace classification_ggml::megaloc {

inline constexpr int IMAGE_SIZE = 322;
inline constexpr int PATCH_SIZE = 14;
inline constexpr int PATCH_COUNT = 529;
inline constexpr int PATCH_WIDTH = 588;
inline constexpr int DESCRIPTOR_LENGTH = 8448;

struct Config {
  std::string modelPath;
  std::string backendsDir;
  std::string backend;
  int threads = 8;
};

class MegaLocModel : public qvac_lib_inference_addon_cpp::model::IModel {
public:
  explicit MegaLocModel(Config config);
  ~MegaLocModel() override;
  MegaLocModel(const MegaLocModel&) = delete;
  MegaLocModel& operator=(const MegaLocModel&) = delete;

  void load();
  [[nodiscard]] std::string getName() const override;
  std::any process(const std::any& input) override;
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  Config config_;
  mutable std::mutex mutex_;
  double lastInferenceMs_ = 0;
};

std::vector<float> preprocess(const ImageInput& input);
int backendId(const char* name);

} // namespace classification_ggml::megaloc
