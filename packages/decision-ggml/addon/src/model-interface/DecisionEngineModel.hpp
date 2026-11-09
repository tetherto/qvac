#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <streambuf>
#include <string>
#include <unordered_map>

#include <llama/common/common.h>

#include "DecisionContext.hpp"
#include "LlamaLazyInitializeBackend.hpp"
#include "inference-addon-cpp/InitLoader.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "inference-addon-cpp/job/JobId.hpp"
#include "utils/JobCancelRegistry.hpp"

/// @brief One upstream decision response, serialized as JSON.
///
/// A distinct type so the JS side can recognize the output event by its type
/// name, as with LayaDecisionResult.
struct DecisionEngineResult {
  std::string json;
};

/// @brief Upstream llama.cpp decision models (openjev, lev, kev, clef, laya in
/// upstream format, ...), run by upstream's server-context through this
/// model's DecisionContext. Fabric-format Laya checkpoints keep using
/// LayaModel.
///
/// Structured like llm-llamacpp's LlamaModel: load options go straight into
/// common_params, the DecisionContext owns the upstream objects, errors are
/// the addon's own, and per-job cancellation goes through a JobCancelRegistry.
/// A request is upstream's /v1/systemone JSON for one state; the result is
/// upstream's response JSON.
///
/// Driven by a MultiJobScheduler (see makeDecisionEngineScheduler): the
/// scheduler announces each job (jobStarting) under its admission lock before
/// the job becomes cancellable, so a cancel that lands before process() starts
/// is held by the registry and applied when the run arms.
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

  /// Untagged path (no scheduler id): runs one job.
  std::any process(const std::any& input) final;

  /// @param input std::string holding upstream's request JSON for one state.
  /// @param id The job announced by jobStarting(id).
  /// @returns DecisionEngineResult holding upstream's response JSON.
  std::any process(const std::any& input, JobId id) final;

  /// Registers the job, not yet cancellable. Runs under the scheduler's
  /// admission lock, before the job can be cancelled.
  void jobStarting(JobId id) final;

  /// Stops the job's run, or holds the cancel until the run arms.
  void cancelById(JobId id) const final;

  /// Cancels every job announced and not yet finished. Point-in-time: jobs
  /// announced afterwards are not affected.
  void cancel() const final;

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  void waitForLoadInitialization() final {
    initLoader_.waitForLoadInitialization();
  }

  /// Weight streaming is not supported: the context loads from a path.
  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final;

  /// @brief The model's decision capabilities (see DecisionContext::info).
  /// Waits for the load.
  std::string info();

  /// @brief Maps addon load options to upstream's parameters. Throws
  /// InvalidConfiguration for an unknown key or a bad value.
  static common_params loadParams(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config);

private:
  void load(const common_params& params);
  DecisionEngineResult run(const std::string& requestJson, JobId id);

  std::string backendsDir_;
  std::string openclCacheDir_;

  // Backends (and their log routing, and the Android OpenCL cache location)
  // are initialized through the addon's shared initializer before the context
  // is created, and released after it is destroyed (declared before
  // context_).
  std::optional<LlamaBackendsHandle> backends_;
  std::unique_ptr<qvac_lib_inference_addon_decision::DecisionContext> context_;
  std::string info_;

  /// Live jobs and how to stop each one's run (see JobCancelRegistry).
  mutable JobCancelRegistry liveJobs_;
  /// Bumped by the whole-model cancel(): a run armed before the bump stops.
  /// Jobs announced but not yet armed are parked in liveJobs_ instead.
  mutable std::atomic<std::uint64_t> cancelEpoch_{0};

  long long lastInputTokens_ = 0;
  double lastMs_ = 0.0;

  // Last member: its deferred init writes the members above.
  InitLoader initLoader_;
};
