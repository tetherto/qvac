#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <variant>

#include "nmt.hpp"
#ifdef HAVE_BERGAMOT
#include "bergamot.hpp"
#endif
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

namespace qvac_lib_inference_addon_marian {

enum class BackendType {
  GGML,
#ifdef HAVE_BERGAMOT
  BERGAMOT
#endif
};

class TranslationModel : public qvac_lib_inference_addon_cpp::model::IModel {
public:
  TranslationModel() {};

  TranslationModel(const std::string& modelPath);

  virtual ~TranslationModel();

  TranslationModel(const TranslationModel&) = delete;

  TranslationModel& operator=(const TranslationModel&) = delete;

  void load();

  void unload(); // TODO Should I remove this function ?

  void reload(); // TODO Should I remove this function ?

  void reset(); // TODO Should I remove this function ?

  void setUseGpu(bool useGpu); // TODO Should I remove this function ?

  std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
  getConfig() const; // TODO Should I remove this function ?

  bool isLoaded() const;

  void setConfig(std::unordered_map<
                 std::string, std::variant<double, int64_t, std::string>>
                     config);

  void saveLoadParams(const std::string& modelPath);

public: // overrides
  std::string getName() const override;

  std::any process(const std::any& input) override;

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

private:
  BackendType detectBackendType(const std::string& modelPath);

  std::string indictransPreProcess(const std::string& text);

  void updateConfig();

  std::vector<std::string> processBatch(const std::vector<std::string>& texts);

  std::string processString(const std::string& input);

private:
  std::string srcLang_;

  std::string tgtLang_;

  std::string modelPath_;

  BackendType backendType_ = BackendType::GGML;

  std::unique_ptr<nmt_context, decltype(&nmt_free)> nmtCtx_{nullptr, nmt_free};

#ifdef HAVE_BERGAMOT
  std::unique_ptr<bergamot_context, decltype(&bergamot_free)> bergamotCtx_{nullptr, bergamot_free};
#endif

  bool isFirstSentence_ = true;

  bool useGpu_ = true; // Default to GPU enabled

  std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
      config_;
};

} // namespace qvac_lib_inference_addon_marian
