#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include "TranslationModel.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"

namespace qvac_lib_inference_addon_marian {

class PivotTranslationModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  PivotTranslationModel() = default;
  PivotTranslationModel(
      const std::string& firstModelPath,
      std::unordered_map<
          std::string, std::variant<double, int64_t, std::string>>
          firstModelconfig,
      const std::string& secondModelPath,
      std::unordered_map<
          std::string, std::variant<double, int64_t, std::string>>
          secondModelConfig = {});

  ~PivotTranslationModel() override = default;

  PivotTranslationModel(const PivotTranslationModel&) = delete;
  PivotTranslationModel& operator=(const PivotTranslationModel&) = delete;
  PivotTranslationModel(PivotTranslationModel&&) noexcept = default;
  PivotTranslationModel& operator=(PivotTranslationModel&&) noexcept = default;

  void load();
  void unload();
  void reload();
  void reset();
  bool isLoaded() const;

  void saveLoadParams(
      const std::string& firstModelPath, const std::string& secondModelPath);
  void setConfig(std::unordered_map<
                 std::string, std::variant<double, int64_t, std::string>>
                     config);
  void setUseGpu(bool useGpu);

  std::string getName() const override;
  std::any process(const std::any& input) override;
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

  void cancel() const override;

private:
  std::any translateString(const std::string& input);
  std::any translateBatch(const std::vector<std::string>& inputs);

  std::string firstModelPath_;
  std::string secondModelPath_;

  std::unique_ptr<TranslationModel> firstModel_;
  std::unique_ptr<TranslationModel> secondModel_;

  bool useGpu_ = true;

  std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
      config_;

  mutable std::atomic<bool> stopTranslation_ = false;
};

} // namespace qvac_lib_inference_addon_marian
