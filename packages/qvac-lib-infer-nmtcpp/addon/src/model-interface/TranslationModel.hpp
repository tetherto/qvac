#pragma once

#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>

#include "NmtLazyInitializeBackend.hpp"
#include "nmt.hpp"
#ifdef HAVE_BERGAMOT
#include "bergamot.hpp"
#endif
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

namespace qvac_lib_inference_addon_nmt {

enum class BackendType {
  GGML,
#ifdef HAVE_BERGAMOT
  BERGAMOT
#endif
};

class TranslationModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  TranslationModel() {};

  TranslationModel(const std::string& modelPath);

  virtual ~TranslationModel();

  TranslationModel(const TranslationModel&) = delete;

  TranslationModel& operator=(const TranslationModel&) = delete;

  void load();

  void unload();

  void reload();

  void reset() const;

  void setUseGpu(bool useGpu);

  void setGpuBackend(const std::string& gpuBackend);

  void setGpuDevice(int gpuDevice);

  std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
  getConfig() const;

  bool isLoaded() const;

  void setConfig(std::unordered_map<
                 std::string, std::variant<double, int64_t, std::string>>
                     config);

  void saveLoadParams(const std::string& modelPath);

  std::vector<std::string> processBatch(const std::vector<std::string>& texts);

  /**
   * Returns the name of the currently-loaded non-CPU backend (e.g. "Vulkan0",
   * "OpenCL", "Metal"), or a sentinel string when no GPU backend is active.
   *
   * Sentinels:
   *   - "Unloaded"     — model is not loaded
   *   - "Bergamot-CPU" — non-GGML backend (Bergamot); CPU-only by design
   *   - "CPU"          — GGML backend loaded but only the CPU backend
   * registered
   *
   * Otherwise returns the device name of the first non-CPU backend in
   * nmtCtx_->state->backends (GPU is always pushed first per nmt_backend_init).
   */
  std::string getActiveBackendName() const;

public: // overrides
  std::string getName() const override;

  std::any process(const std::any& input) override;

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

  void cancel() const override;

private:
  BackendType detectBackendType(const std::string& modelPath);

  std::string indictransPreProcess(const std::string& text);

  void updateConfig();

  std::string processString(const std::string& input);

private:
  mutable std::mutex mtx_;

  std::string srcLang_;

  std::string tgtLang_;

  std::string modelPath_;

  BackendType backendType_ = BackendType::GGML;

  mutable std::unique_ptr<nmt_context, decltype(&nmt_free)> nmtCtx_{
      nullptr, nmt_free};

#ifdef HAVE_BERGAMOT
  std::unique_ptr<bergamot_context, decltype(&bergamot_free)> bergamotCtx_{
      nullptr, bergamot_free};
#endif

  mutable bool isFirstSentence_ = true;

  bool useGpu_ = false;

  // Case-insensitive substring filter over ggml device names (e.g. "vulkan",
  // "vulkan0", "opencl", "metal"). Populated from the "gpu_backend" config
  // key by setConfig(). Empty → default gated selection in
  // nmt_backend_init_gpu.
  std::string gpuBackend_;

  int gpuDevice_ = 0;

  // Cached at load() time; cleared on unload(). Avoids mutex + ggml traversal
  // on every getActiveBackendName() call since the active backend is immutable
  // after load().
  std::string activeBackendName_;

  std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
      config_;

  std::optional<NmtBackendsHandle> backendsHandle_;
};

} // namespace qvac_lib_inference_addon_nmt
