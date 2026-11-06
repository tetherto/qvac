#pragma once

#include <memory>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/job/MultiJobScheduler.hpp>

namespace qvac_lib_inference_addon_embed {

/// The scheduler a DecisionEngine instance runs under.
///
/// - Tagged jobs: the model creates each job's cancellation token in
///   jobStarting(id), under the scheduler's admission lock, so a cancel that
///   lands before process() starts still reaches the job.
/// - One worker and no waiting room (queueCapacity 0): a job submitted while
///   one is in flight is rejected, not queued, which is runJob()'s documented
///   "false if busy" contract. Callers queue in JS.
///
/// A template so tests can drive it with a stub model implementing the same
/// interfaces.
template <typename ModelT>
std::unique_ptr<qvac_lib_inference_addon_cpp::MultiJobScheduler>
makeDecisionEngineScheduler(ModelT& model) {
  using namespace qvac_lib_inference_addon_cpp;
  constexpr unsigned kWorkers = 1;
  constexpr unsigned kQueueCapacity = 0;
  return std::make_unique<MultiJobScheduler>(
      static_cast<model::IModelMultiprocessor*>(&model),
      kWorkers,
      static_cast<model::IModelCancel*>(&model),
      static_cast<model::IModelCancelById*>(&model),
      kQueueCapacity);
}

} // namespace qvac_lib_inference_addon_embed
