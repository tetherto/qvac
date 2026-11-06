#pragma once

#include <any>
#include <memory>
#include <mutex>
#include <optional>
#include <streambuf>
#include <string>
#include <unordered_map>

#include <qvac-fabric.h>

#include "LlamaLazyInitializeBackend.hpp"
#include "inference-addon-cpp/InitLoader.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "inference-addon-cpp/job/JobId.hpp"

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
/// job, and bridge statuses to addon errors. A request is upstream's
/// /v1/systemone JSON for one state; the result is upstream's response JSON.
/// Fabric-format Laya checkpoints keep using LayaModel.
///
/// Driven by a MultiJobScheduler so that cancellation is tied to job ids: the
/// scheduler announces each job (jobStarting) under its admission lock before
/// the job becomes cancellable, and the job's token is created there. A cancel
/// that lands before process() starts therefore reaches the job's token
/// instead of being lost.
class DecisionEngineModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelMultiprocessor,
      public qvac_lib_inference_addon_cpp::model::IModelCancelById,
      public qvac_lib_inference_addon_cpp::model::IModelJobLifecycle {
public:
  using Input = std::string;
  using Output = DecisionEngineResult;
  using JobId = qvac_lib_inference_addon_cpp::JobId;

  /// @param config Load options; any other key is rejected with
  /// InvalidConfiguration.
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

  /// Untagged path (no scheduler id): announces and runs one job.
  std::any process(const std::any& input) final;

  /// @param input std::string holding upstream's request JSON for one state.
  /// @param id The job announced by jobStarting(id).
  /// @returns DecisionEngineResult holding upstream's response JSON.
  std::any process(const std::any& input, JobId id) final;

  /// Creates the job's cancellation token. Runs under the scheduler's
  /// admission lock, before the job can be cancelled.
  void jobStarting(JobId id) final;

  /// Cancels the job's run, or its run-to-be if process() has not started.
  void cancelById(JobId id) const final;

  /// Cancels every job announced and not yet finished. Point-in-time: jobs
  /// announced afterwards are not affected.
  void cancel() const final;

  /// Runs one request under @p id's token (announced by jobStarting).
  DecisionEngineResult predict(const std::string& requestJson, JobId id);

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

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
  /// The job's token, retained for the caller; created if the job was never
  /// announced (defensive: the scheduler always announces).
  qvac_fabric_decision_cancel* retainToken(JobId id);
  void finishJob(JobId id, qvac_fabric_decision_cancel* token);

  std::string backendsDir_;
  std::string openclCacheDir_;

  // Backends (and their log routing, and the Android OpenCL cache location)
  // are initialized through the addon's shared initializer before the engine
  // is created, and released after it is destroyed (declared before engine_).
  std::optional<LlamaBackendsHandle> backends_;
  qvac_fabric_decision* engine_ = nullptr;
  std::string info_;

  // Tokens of the jobs announced and not yet finished, by job id.
  mutable std::mutex tokensMutex_;
  std::unordered_map<JobId, qvac_fabric_decision_cancel*> tokens_;

  long long lastInputTokens_ = 0;
  double lastMs_ = 0.0;

  // Last member: its deferred init writes the members above.
  InitLoader initLoader_;
};
