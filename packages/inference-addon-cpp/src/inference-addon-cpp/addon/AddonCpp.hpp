#pragma once

// NOTE: Do not include <js.h> here to avoid pollution of C++ interface. Please
// use AddonJs instead.
#include <cstddef>
#include <functional>
#include <memory>
#include <stdexcept>

#include "../Logger.hpp"
#include "../ModelInterfaces.hpp"
#include "../job/IJobScheduler.hpp"
#include "../job/JobId.hpp"
#include "../job/MultiJobScheduler.hpp"
#include "../job/SingleJobScheduler.hpp"
#include "../queue/OutputCallbackInterface.hpp"
#include "../queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

/// @brief Pure C++ class (no bare or Js runtime variables, see `AddonJs`
/// instead)
class AddonCpp {
  const std::unique_ptr<model::IModel> model_;
  std::unique_ptr<OutputCallBackInterface> outputCallback_;

public:
  const std::shared_ptr<OutputQueue> outputQueue;

private:
  std::unique_ptr<IJobScheduler> jobScheduler_;

  /// Adopt the caller-supplied scheduler after verifying (through friend
  /// access to the known implementations) that it was built against @p model —
  /// a scheduler holds raw pointers into its model, so a mismatch would be
  /// silent undefined behaviour — or build the default single-job scheduler
  /// when none was supplied.
  static std::unique_ptr<IJobScheduler> adoptScheduler(
      std::unique_ptr<IJobScheduler> scheduler, model::IModel* model) {
    if (scheduler == nullptr) {
      return std::make_unique<SingleJobScheduler>(
          model, dynamic_cast<model::IModelCancel*>(model));
    }
    const bool mismatch = [&] {
      if (const auto* multi =
              dynamic_cast<const MultiJobScheduler*>(scheduler.get())) {
        return multi->multiprocessor_ !=
            dynamic_cast<model::IModelMultiprocessor*>(model);
      }
      if (const auto* single =
              dynamic_cast<const SingleJobScheduler*>(scheduler.get())) {
        return single->model_ != model;
      }
      return false; // unknown implementation: nothing to verify against
    }();
    if (mismatch) {
      throw std::invalid_argument(
          "scheduler must be built against the model passed to AddonCpp");
    }
    return scheduler;
  }

public:
  /**
   * @brief Constructor for the Addon class
   * @param outputCallback Output callback to handle results
   * @param model Model interface implementation
   * @param scheduler Optional caller-supplied admission strategy; when null a
   *        single-job scheduler is built by default. A caller wanting
   *        multi-job admission constructs that scheduler itself (choosing the
   *        concurrency level) and passes it here. It must be built against the
   *        exact instance passed as @p model — verified at construction, which
   *        throws std::invalid_argument on a mismatch. AddonCpp guarantees the
   *        model outlives the scheduler.
   */
  AddonCpp(
      std::unique_ptr<OutputCallBackInterface>&& outputCallback,
      std::unique_ptr<model::IModel>&& model,
      std::unique_ptr<IJobScheduler> scheduler = nullptr)
      : model_(std::move(model)), outputCallback_(std::move(outputCallback)),
        outputQueue(std::make_shared<OutputQueue>(*outputCallback_, *model_)),
        jobScheduler_(adoptScheduler(std::move(scheduler), model_.get())),
        model(*this->model_),
        asyncLoad(dynamic_cast<model::IModelAsyncLoad*>(model_.get())) {
    outputCallback_->initializeProcessingThread(outputQueue);
    jobScheduler_->start(outputQueue);
  }

  /**
   * @brief Signals to activate processing and notifies processing thread.
   *        Will trigger model load into the ML engine if necessary.
   */
  void activate() const {
    if (asyncLoad != nullptr) {
      asyncLoad->waitForLoadInitialization();
    }
  }

  ~AddonCpp() { outputCallback_->stop(); }

  /// @returns False if the job cannot be run (e.g. at capacity or a job is
  /// already being processed)
  bool runJob(std::any input, JobId id = kNoJobId) {
    return jobScheduler_->runJob(std::move(input), id);
  }

  /// @returns False if the exclusive job cannot be run because other jobs are
  /// queued or in flight (see IJobScheduler::runExclusiveJob).
  bool runExclusiveJob(std::any input, JobId id = kNoJobId) {
    return jobScheduler_->runExclusiveJob(std::move(input), id);
  }
  void cancelJob(JobId id = kNoJobId) { jobScheduler_->cancel(id); }
  void cancelAllJobs() { jobScheduler_->cancelAll(); }

  /// Active jobs (in-flight + queued) per the scheduler.
  [[nodiscard]] std::size_t activeJobs() const { return jobScheduler_->activeJobs(); }

  const std::reference_wrapper<model::IModel> model;
  model::IModelAsyncLoad* const asyncLoad;
};

} // namespace qvac_lib_inference_addon_cpp
