#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <variant>

#include "nmt.hpp"
#ifdef HAVE_BERGAMOT
#include "bergamot.hpp"
#endif
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

namespace qvac_lib_inference_addon_mlc_marian {

enum class BackendType {
  GGML,
#ifdef HAVE_BERGAMOT
  BERGAMOT
#endif
};

class TranslationModel {
public:
  using Input = std::string;
  using InputView = std::string_view;
  using Output = std::string;

  TranslationModel() = default;
  explicit TranslationModel(const std::string& modelPath);
  void unload();
  void load();
  void reload();
  void saveLoadParams(const std::string &modelPath);
  void setConfig(
      std::unordered_map<std::string, std::variant<double, int64_t, std::string>> config);
  void setUseGpu(bool useGpu);

  void unloadWeights();

  std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
  getConfig() const;
  void reset();
  void initializeBackend();
  bool isLoaded() const;

  std::string process(const std::string &text);
  std::string process(
      const std::string& text,
      const std::function<void(const Output&)>& consumer);

  std::vector<std::string> processBatch(const std::vector<std::string>& texts);

  std::string runtimeStatsToString() const;
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const;

  virtual ~TranslationModel();

  TranslationModel(const TranslationModel&) = delete;
  TranslationModel& operator=(const TranslationModel&) = delete;
  TranslationModel(TranslationModel&&) noexcept = default;
  TranslationModel& operator=(TranslationModel&&) noexcept = default;


private:
  size_t instance_id_{};

  std::string modelPath_;
  BackendType backendType_ = BackendType::GGML;
  std::unique_ptr<nmt_context, decltype(&nmt_free)> nmtCtx_{nullptr, nmt_free};
#ifdef HAVE_BERGAMOT
  std::unique_ptr<bergamot_context, decltype(&bergamot_free)> bergamotCtx_{nullptr, bergamot_free};
#endif
  std::unordered_map<std::string, std::variant<double, int64_t, std::string>> config_;
  bool useGpu_ = true;  // Default to GPU enabled

  // IndicTrans2
  bool isFirstSentence_ = true;
  std::string srcLang_;
  std::string tgtLang_;

  std::string indictransPreProcess(const std::string &text);

  void updateConfig();
  BackendType detectBackendType(const std::string& modelPath);
};

} // namespace qvac_lib_inference_addon_mlc_marian
