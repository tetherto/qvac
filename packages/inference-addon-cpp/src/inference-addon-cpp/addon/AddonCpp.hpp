#pragma once

// NOTE: Do not include <js.h> here to avoid pollution of C++ interface. Please
// use AddonJs instead.
#include <cstddef>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <vector>

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

  /// Adopt the caller-supplied scheduler after verifying (through the
  /// IJobScheduler::isBoundTo contract) that it was built against @p model — a
  /// scheduler holds raw pointers into its model, so a mismatch would be silent
  /// undefined behaviour — or build the default single-job scheduler when none
  /// was supplied.
  static std::unique_ptr<IJobScheduler> adoptScheduler(
      std::unique_ptr<IJobScheduler> scheduler, model::IModel* model) {
    if (scheduler == nullptr) {
      return std::make_unique<SingleJobScheduler>(
          model, dynamic_cast<model::IModelCancel*>(model));
    }
    if (!scheduler->isBoundTo(*model)) {
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
   *        exact instance passed as @p model — verified at construction via
   *        IJobScheduler::isBoundTo (so any implementation participates),
   *        throwing std::invalid_argument on a mismatch. AddonCpp guarantees
   *        the model outlives the scheduler.
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

  // The scheduler must go before stop(): its teardown terminal events are
  // only delivered while the callback's notify() is live.
  ~AddonCpp() {
    jobScheduler_.reset();
    outputCallback_->stop();
  }

  /// @returns The id the scheduler assigned to the admitted job (kNoJobId on
  /// the untagged single-job path, a fresh never-reused id on the multi-job
  /// path), or nullopt if the job cannot be run (e.g. at capacity or a job is
  /// already being processed)
  std::optional<JobId> runJob(std::any input) {
    return jobScheduler_->runJob(std::move(input));
  }

  /// @returns The assigned id, or nullopt if the exclusive job cannot be run
  /// because other jobs are queued or in flight (see
  /// IJobScheduler::runExclusiveJob).
  std::optional<JobId> runExclusiveJob(std::any input) {
    return jobScheduler_->runExclusiveJob(std::move(input));
  }
  void cancelJob(JobId id = kNoJobId) { jobScheduler_->cancel(id); }
  void cancelAllJobs() { jobScheduler_->cancelAll(); }

  /// Live (queued + in-flight) job ids; pairs with cancelJobs for the
  /// snapshot-based cancel-all (see IJobScheduler::liveJobIds).
  [[nodiscard]] std::vector<JobId> liveJobIds() const {
    return jobScheduler_->liveJobIds();
  }
  void cancelJobs(const std::vector<JobId>& ids) {
    jobScheduler_->cancelJobs(ids);
  }

  /// Active jobs (in-flight + queued) per the scheduler.
  [[nodiscard]] std::size_t activeJobs() const { return jobScheduler_->activeJobs(); }

  const std::reference_wrapper<model::IModel> model;
  model::IModelAsyncLoad* const asyncLoad;
};

} // namespace qvac_lib_inference_addon_cpp
