#include "PivotTranslationModel.hpp"

#include <stdexcept>
#include <utility>

namespace qvac_lib_inference_addon_nmt {

PivotTranslationModel::PivotTranslationModel(
    const std::string& firstModelPath,
    std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
        firstModelConfig,
    const std::string& secondModelPath,
    std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
        secondModelConfig)
    : firstModelPath_(firstModelPath), secondModelPath_(secondModelPath),
      firstModel_(std::make_unique<TranslationModel>(firstModelPath)),
      secondModel_(std::make_unique<TranslationModel>(secondModelPath)),
      stopTranslation_(false) {

  firstModel_->setConfig(std::move(firstModelConfig));
  secondModel_->setConfig(std::move(secondModelConfig));

  firstModel_->load();
  secondModel_->load();
}

void PivotTranslationModel::load() {
#ifndef HAVE_BERGAMOT
  throw std::runtime_error(
      "PivotTranslationModel requires Bergamot support at build time");
#else
  firstModel_->setUseGpu(useGpu_);
  secondModel_->setUseGpu(useGpu_);

  firstModel_->setConfig(config_);
  secondModel_->setConfig(config_);

  firstModel_->saveLoadParams(firstModelPath_);
  secondModel_->saveLoadParams(secondModelPath_);

  firstModel_->load();
  secondModel_->load();
#endif
}

void PivotTranslationModel::unload() {
  firstModel_->unload();
  secondModel_->unload();
}

void PivotTranslationModel::reload() {
  unload();
  load();
}

void PivotTranslationModel::reset() {
  stopTranslation_.store(false);
  firstModel_->reset();
  secondModel_->reset();
}

bool PivotTranslationModel::isLoaded() const {
  return firstModel_->isLoaded() && secondModel_->isLoaded();
}

void PivotTranslationModel::saveLoadParams(
    const std::string& firstModelPath, const std::string& secondModelPath) {
  firstModelPath_ = firstModelPath;
  secondModelPath_ = secondModelPath;
}

void PivotTranslationModel::setConfig(
    std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
        config) {
  config_ = std::move(config);
  firstModel_->setConfig(config_);
  secondModel_->setConfig(config_);
}

void PivotTranslationModel::setUseGpu(bool useGpu) {
  useGpu_ = useGpu;
  firstModel_->setUseGpu(useGpu_);
  secondModel_->setUseGpu(useGpu_);
}

std::string PivotTranslationModel::getName() const {
  return "PivotTranslationModel";
}

std::any PivotTranslationModel::process(const std::any& input) {
  if (const auto* text = std::any_cast<std::string>(&input)) {
    return translateString(*text);
  }

  if (const auto* batch = std::any_cast<std::vector<std::string>>(&input)) {
    return translateBatch(*batch);
  }

  throw std::runtime_error("PivotTranslationModel expects std::string or "
                           "std::vector<std::string> input");
}

qvac_lib_inference_addon_cpp::RuntimeStats
PivotTranslationModel::runtimeStats() const {
  auto firstStats = firstModel_->runtimeStats();
  auto secondStats = secondModel_->runtimeStats();

  qvac_lib_inference_addon_cpp::RuntimeStats merged;
  for (const auto& [key, value] : firstStats) {
    merged.push_back(std::make_pair(firstModel_->getName() + key, value));
  }
  for (const auto& [key, value] : secondStats) {
    merged.push_back(std::make_pair(secondModel_->getName() + key, value));
  }
  return merged;
}

void PivotTranslationModel::cancel() const {
  stopTranslation_.store(true);
  firstModel_->cancel();
  secondModel_->cancel();
}

std::any PivotTranslationModel::translateString(const std::string& input) {
  if (!isLoaded()) {
    throw std::runtime_error("PivotTranslationModel models are not loaded");
  }

  if (stopTranslation_.load()) {
    return std::any{};
  }

  const std::any firstOutput = firstModel_->process(input);

  if (stopTranslation_.load()) {
    return std::any{};
  }

  return secondModel_->process(firstOutput);
}

std::any
PivotTranslationModel::translateBatch(const std::vector<std::string>& inputs) {
  if (!isLoaded()) {
    throw std::runtime_error("PivotTranslationModel models are not loaded");
  }

  if (stopTranslation_.load()) {
    return std::any{};
  }

  auto firstBatch = firstModel_->processBatch(inputs);

  if (stopTranslation_.load()) {
    return std::any{};
  }

  return secondModel_->processBatch(firstBatch);
}

} // namespace qvac_lib_inference_addon_nmt
