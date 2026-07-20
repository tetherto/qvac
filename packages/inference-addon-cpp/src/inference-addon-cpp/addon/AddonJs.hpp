#pragma once

#include <js.h>

#include <optional>
#include <utility>
#include <vector>

#include "../JsBlobsStream.hpp"
#include "../JsUtils.hpp"
#include "../Logger.hpp"
#include "../ModelInterfaces.hpp"
#include "AddonCpp.hpp"

namespace qvac_lib_inference_addon_cpp {

/// @brief Extends pure C++ AddonCpp class with JS specific functionality (e.g.
/// JS blob stream loading for model weights)
class AddonJs {
  std::mutex mtx_;
  js_env_t* env_;
  js_blobs::WeightsLoader<char> weights_loader_;
  js::ThreadQueuedRefDeleter weights_deleter_ = {};

  js_value_t* admissionToJs(const std::optional<JobId>& id) {
    if (!id.has_value()) {
      return js::Boolean::create(env_, false);
    }
    if (*id == kNoJobId) {
      // Untagged single-job path: the sentinel is useless to JS (events
      // carry no correlatable id, cancel is the no-arg form) and Number 0
      // is falsy, which would read as a rejection to every consumer gating
      // on `if (!accepted)`. Keep the legacy truthy contract instead.
      return js::Boolean::create(env_, true);
    }
    return js::Number::create(env_, *id);
  }

public:
  const std::shared_ptr<AddonCpp> addonCpp;

  /// @param scheduler Optional caller-supplied admission strategy, forwarded to
  ///        AddonCpp; null selects AddonCpp's default single-job scheduler.
  AddonJs(
      js_env_t* env, std::unique_ptr<OutputCallBackInterface>&& outputCallback,
      std::unique_ptr<model::IModel>&& model,
      std::unique_ptr<IJobScheduler> scheduler = nullptr)
      : env_(env), addonCpp(
                       std::make_shared<AddonCpp>(
                           std::move(outputCallback), std::move(model),
                           std::move(scheduler))) {}

  ~AddonJs() = default;

  /// @returns JS number >= 1: the job id the scheduler assigned (tagged,
  /// multi-job path). JS Boolean true when the job was accepted on the
  /// untagged single-job path (its events carry no correlatable id). JS
  /// Boolean false when the job was rejected, e.g. because a job is already
  /// set or being processed. Never falsy on success.
  js_value_t* runJob(std::any input) {
    return admissionToJs(addonCpp->runJob(std::move(input)));
  }

  /// @returns JS number >= 1 (the assigned job id) or JS Boolean true on the
  /// untagged single-job path, or JS Boolean false when the exclusive job
  /// (e.g. finetune) is refused because inference jobs are queued or in
  /// flight.
  js_value_t* runExclusiveJob(std::any input) {
    return admissionToJs(addonCpp->runExclusiveJob(std::move(input)));
  }

  /**
   * @brief Cancels jobs asynchronously
   * @param id Optional job id. Present cancels only that job; a scheduler that
   *        cannot map the id to a job warns and does nothing. Absent cancels
   *        every job live right now: the id snapshot is taken here, on the JS
   *        thread — where admissions also run — and only that set is passed
   *        to the deferred cancellation. On the tagged multi-job path ids are
   *        never reused, so jobs started after this call are never touched.
   *        The untagged single-job path can only snapshot the kNoJobId
   *        sentinel, which pins the slot rather than the job: a cancel
   *        executing after the snapshotted job already finished can land on
   *        the slot's next occupant, unless the model itself pins cancels to
   *        the run they were aimed at (as llm-llamacpp does).
   * @return JavaScript Promise that resolves when cancellation completes
   * @note This is a non-blocking operation that returns a future/promise
   */
  js_value_t* cancelJob(std::optional<JobId> id = std::nullopt) {
    if (id.has_value()) {
      return js::JsAsyncTask::run(env_, [addonCppRef = addonCpp, id = *id]() {
        addonCppRef->cancelJob(id);
      });
    }
    std::vector<JobId> snapshot = addonCpp->liveJobIds();
    return js::JsAsyncTask::run(
        env_, [addonCppRef = addonCpp, snapshot = std::move(snapshot)]() {
          addonCppRef->cancelJobs(snapshot);
        });
  }

  /**
   * @brief Loads model weights from JavaScript blob data
   * @param env JavaScript environment handle
   * @param weightsData JavaScript value containing weights blob data
   */
  void loadWeights(js_env_t* env, js_value_t* weightsData) {
    {
      model::IModelAsyncLoad* asyncLoad = addonCpp->asyncLoad;
      if (asyncLoad == nullptr) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            "Tried to load weights but model '" +
                addonCpp->model.get().getName() +
                "' does not implement IModelAsyncLoad interface.");
        return;
      }

      std::scoped_lock lock(mtx_);

      js_blobs::WeightsBlob weightsDataBlob(
          this->env_, weightsData, &this->weights_deleter_);

      std::unique_ptr<js_blobs::FinalizedStream<char>> finalized =
          weights_loader_.appendBlob(this->env_, std::move(weightsDataBlob));
      if (finalized) {
        const std::string& filename = finalized->filename;
        std::unique_ptr<std::basic_streambuf<char>> shard_streambuf(
            std::move(finalized));
        // Should block on last weights file to wait for model to be loaded.
        asyncLoad->setWeightsForFile(filename, std::move(shard_streambuf));

        // Clear blobs marked for deletion on same loading thread.
        constexpr bool force_sync = true;
        this->weights_deleter_.template clear<force_sync>();
      } else {
        constexpr bool force_sync = false;
        this->weights_deleter_.template clear<force_sync>();
      }
    }
  }
};

} // namespace qvac_lib_inference_addon_cpp
