#pragma once

#include <any>
#include <atomic>
#include <memory>
#include <mutex>
#include <streambuf>
#include <string>
#include <unordered_map>

#include <qvac-fabric.h>

#include "inference-addon-cpp/InitLoader.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"

/// @brief One upstream decision response, serialized as JSON.
///
/// A distinct type so the JS side can recognize the output event by its type
/// name, as with LayaDecisionResult.
struct DecisionEngineResult {
  std::string json;
};

/// @brief Upstream llama.cpp decision models (openjev, lev, kev, clef, laya in
/// upstream format, ...) through @qvac/fabric's qvac_fabric_decision_* bridge.
///
/// Decision parsing, prompt rendering, scheduling and answer calculation are
/// upstream's, inside the shared fabric runtime. This class maps the addon's
/// job lifecycle to the bridge: a delayed load, one cancellation token per
/// running job, and bridge statuses to addon errors. A request is upstream's
/// /v1/systemone JSON for one state; the result is upstream's response JSON.
/// Fabric-format Laya checkpoints keep using LayaModel.
class DecisionEngineModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  using Input = std::string;
  using Output = DecisionEngineResult;

  /// @param config Load options; any other key is rejected with
  /// InvalidConfiguration. The bridge loads the backends itself, so
  /// backendsDir is accepted for interface parity and not used.
  DecisionEngineModel(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config,
      const std::string& backendsDir = "");

  ~DecisionEngineModel() override;
  DecisionEngineModel(const DecisionEngineModel&) = delete;
  DecisionEngineModel& operator=(const DecisionEngineModel&) = delete;
  DecisionEngineModel(DecisionEngineModel&&) = delete;
  DecisionEngineModel& operator=(DecisionEngineModel&&) = delete;

  [[nodiscard]] std::string getName() const final {
    return "DecisionEngineModel";
  }

  /// @param input std::string holding upstream's request JSON for one state.
  /// @returns DecisionEngineResult holding upstream's response JSON.
  std::any process(const std::any& input) final;

  DecisionEngineResult predict(const std::string& requestJson);

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  /// Cancels the running job, if any. Thread-safe.
  void cancel() const final;

  void waitForLoadInitialization() final {
    initLoader_.waitForLoadInitialization();
  }

  /// Weight streaming is not supported: the bridge loads from a path.
  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final;

  /// @brief The model's decision capabilities (bridge JSON, see
  /// qvac_fabric_decision_info). Waits for the load.
  std::string info();

  /// @brief Maps addon load options to the bridge's params JSON. Throws
  /// InvalidConfiguration for an unknown key or a bad value.
  static std::string paramsJson(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config);

private:
  void load(const std::string& paramsJson);

  qvac_fabric_decision* engine_ = nullptr;
  std::string info_;

  // The token of the job being processed; cancel() requests it. Guarded by
  // cancelMutex_ because cancel() runs on another thread than process().
  mutable std::mutex cancelMutex_;
  qvac_fabric_decision_cancel* running_ = nullptr;

  long long lastInputTokens_ = 0;
  double lastMs_ = 0.0;

  // Last member: its deferred init writes the members above.
  InitLoader initLoader_;
};
