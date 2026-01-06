#include "Addon.hpp"

#include <mutex>
#include <unordered_map>

namespace qvac_lib_inference_addon_cpp {

// Static map to store model references for batch processing
// This allows processBatch to access the model without modifying the base Addon
// class
static std::mutex modelMapMutex;
static std::unordered_map<
    void*, qvac_lib_inference_addon_mlc_marian::TranslationModel*>
    addonToModelMap;

// Helper function to register a model for an addon instance
void registerModelForAddon(
    void* addonPtr,
    qvac_lib_inference_addon_mlc_marian::TranslationModel* modelPtr) {
  std::scoped_lock lock(modelMapMutex);
  addonToModelMap[addonPtr] = modelPtr;
}

// Helper function to unregister a model when addon is destroyed
void unregisterModelForAddon(void* addonPtr) {
  std::scoped_lock lock(modelMapMutex);
  addonToModelMap.erase(addonPtr);
}

// Helper function to get model for batch processing
qvac_lib_inference_addon_mlc_marian::TranslationModel*
getModelForAddon(void* addonPtr) {
  std::scoped_lock lock(modelMapMutex);
  auto it = addonToModelMap.find(addonPtr);
  if (it != addonToModelMap.end()) {
    return it->second;
  }
  return nullptr;
}

// ADDON_CTOR_NOLINT_BEGIN
// NOLINTBEGIN(cppcoreguidelines-pro-type-member-init)
template <>
void qvac_lib_inference_addon_mlc_marian::Addon::loadWeights(
    js_env_t* env, js_value_t* weightsData) {}

template <> std::string qvac_lib_inference_addon_mlc_marian::Addon::getNextPiece(std::string &input, size_t lastPieceEnd) {
  auto pieceEnd = input.find_first_of(".!?", lastPieceEnd);
  if (pieceEnd != std::string::npos) {
    ++pieceEnd;
  }
  return input.substr(lastPieceEnd, pieceEnd - lastPieceEnd);
}

template <> // NOLINT(cppcoreguidelines-pro-type-member-init)
template <> // NOLINT(cppcoreguidelines-pro-type-member-init)
// NOLINTNEXTLINE(cppcoreguidelines-pro-type-member-init)
qvac_lib_inference_addon_mlc_marian::Addon::
    Addon( // NOLINT(cppcoreguidelines-pro-type-member-init)
        js_env_t* env, std::reference_wrapper<const std::string> modelPath,
        std::unordered_map<std::string, std::variant<double, int64_t, std::string>> config,
        bool useGpu,
        js_value_t* jsHandle, js_value_t* outputCb,
        js_value_t*
            transitionCb) // NOLINT(cppcoreguidelines-pro-type-member-init)
    : env_{env}, transitionCb_{transitionCb}, model_{modelPath},
      jsHandle_{nullptr}, outputCb_{nullptr}, jsOutputCallbackAsyncHandle_{},
      threadsafeOutputCb_{
          nullptr} { // NOLINT(cppcoreguidelines-pro-type-member-init)
  model_.setUseGpu(useGpu);
  model_.setConfig(std::move(config));
  model_.load();
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
  // Register model for batch processing access
  registerModelForAddon(this, &model_);
}
// NOLINTEND(cppcoreguidelines-pro-type-member-init)
// ADDON_CTOR_NOLINT_END

template <>
void qvac_lib_inference_addon_mlc_marian::Addon::processSignalUnloadWeights(
    std::string& input) {
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "Invalid signal: UnloadWeights");
}

template <>
void qvac_lib_inference_addon_mlc_marian::Addon::processSignalFinetune(
    std::string& input) {
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument, "Invalid signal: Finetune");
}

template <>
template <>
void qvac_lib_inference_addon_mlc_marian::Addon::load(
    std::string modelPath,
    std::unordered_map<std::string, std::variant<double, int64_t, std::string>> config) {
  {
    std::scoped_lock lock(mtx_);
    if (status_ != AddonStatus::Unloaded)
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "load called when status not UNLOADED");
    model_.saveLoadParams(modelPath);
    signal_ = ProcessSignals::Load;
    if (!config.empty()) {
      model_.setConfig(std::move(config));
    }
  }
}

template <>
template <>
void qvac_lib_inference_addon_mlc_marian::Addon::reload(
    std::string modelPath,
    std::unordered_map<std::string, std::variant<double, int64_t, std::string>> config) {
  {
    std::scoped_lock lock(mtx_);
    if (!modelPath.empty()) {
      model_.saveLoadParams(modelPath);
      signal_ = ProcessSignals::Reload;
    }
    if (!config.empty()) {
      model_.setConfig(std::move(config));
    }
  }
}

} // namespace qvac_lib_inference_addon_cpp
