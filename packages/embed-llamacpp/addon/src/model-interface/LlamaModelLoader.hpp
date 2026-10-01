#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <streambuf>
#include <string>
#include <unordered_map>

#include <llama/common/common.h>

#include "AsyncWeightsLoader.hpp"
#include "BackendSelection.hpp"
#include "LlamaLazyInitializeBackend.hpp"
#include "ModelMetadata.hpp"
#include "inference-addon-cpp/GGUFShards.hpp"
#include "inference-addon-cpp/InitLoader.hpp"

struct LlamaCommonInitResult {
  common_params params;
  common_init_result_ptr result;
};

/// @brief Bundle of parameters required to load a model: the parsed llama.cpp
/// common_params, plus addon-specific flags resolved during setup (whether the
/// caller explicitly configured ctx_size, and which backend device was
/// selected).
struct LlamaModelSetup {
  common_params params;
  bool ctxSizeConfigured = false;
  int64_t resolvedBackendDevice = 0;
};

/// Apply the final split-device handles and remap positional tensor shares.
void applySplitDeviceSelection(
    common_params& params, std::unordered_map<std::string, std::string>& config,
    const backend_selection::SplitDeviceSelection& selection);

/// Traits of the whole split set; requires a non-empty set.
struct SplitBackendTraits {
  std::string backendName;
  bool isOpenCl = false;
};

SplitBackendTraits
splitBackendTraits(const backend_selection::SplitDeviceSelection& selection);

/// @brief Loads a llama model and context for the addon's model classes.
///
/// Owns everything a load needs that does not depend on what the model is used
/// for: the config to common_params translation with backend and split-device
/// selection, the GGUF shards and metadata, streamed weights, the backends
/// handle and the deferred (InitLoader) initialization. A model class owns one
/// loader and customizes the load through @ref Hooks.
///
/// The hooks run inside the deferred initialization, which InitLoader triggers
/// from waitForLoadInitialization() or a background thread once the owning
/// model is fully constructed. Declare the loader after the members its hooks
/// write, so the llama context it owns is freed before them. InitLoader does
/// not join a background load when destroyed: destroy the owner only once the
/// load has finished or failed.
class LlamaModelLoader {
public:
  struct Hooks {
    /// After the GGUF metadata is parsed and before the model is created.
    std::function<void(
        common_params& params, const ModelMetaData& metadata,
        bool ctxSizeConfigured)>
        configureParams;
    /// Once the model and context exist; throwing rejects the load.
    std::function<void(llama_model* model, llama_context* ctx)> onLoaded;
  };

  /// @brief Resolves shard basenames in-place to absolute paths relative to
  /// the parent directory of @p modelPath. `GGUFShards::expandGGUFIntoShards`
  /// only populates basenames; resolving them is required for both pre-load
  /// metadata inspection and `llama_model_load_from_splits` when the working
  /// directory differs from the model directory.
  static void
  resolveShardPaths(GGUFShards& shards, const std::string& modelPath);

  /// @param modelName Prefix of the llama.cpp loading context, unique per
  /// loader instance.
  LlamaModelLoader(
      const std::string& modelName, Hooks hooks,
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config,
      const std::string& backendsDir);

  /// @brief Load from already parsed parameters.
  LlamaModelLoader(
      const std::string& modelName, Hooks hooks, LlamaModelSetup& setup);

  LlamaModelLoader(const LlamaModelLoader&) = delete;
  LlamaModelLoader& operator=(const LlamaModelLoader&) = delete;
  LlamaModelLoader(LlamaModelLoader&&) = delete;
  LlamaModelLoader& operator=(LlamaModelLoader&&) = delete;
  ~LlamaModelLoader() = default;

  void initializeBackend(
      const std::string& backendsDir = "",
      const std::string& openclCacheDir = "");

  void waitForLoadInitialization() { initLoader_.waitForLoadInitialization(); }

  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard);

  [[nodiscard]] bool isLoaded() const;
  [[nodiscard]] llama_model* model() const { return model_; }
  [[nodiscard]] llama_context* context() const { return ctx_; }
  [[nodiscard]] const common_params& params() const { return init_.params; }
  [[nodiscard]] int64_t runtimeBackendDevice() const {
    return runtimeBackendDevice_;
  }

private:
  void init(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config,
      const std::string& backendsDir);
  void init(LlamaModelSetup& setup);

  LlamaCommonInitResult init_;
  llama_model* model_ = nullptr;
  llama_context* ctx_ = nullptr;
  bool loaded_ = false;
  Hooks hooks_;

  const std::string loadingContext_;
  GGUFShards shards_;
  InitLoader initLoader_;
  std::optional<LlamaBackendsHandle> backendsHandle_;
  int64_t runtimeBackendDevice_ = 0;
  ModelMetaData metadata_;
  AsyncWeightsLoader asyncWeightsLoader_;
};
