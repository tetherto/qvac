#pragma once

#include <js.h>

#include <optional>

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

  /// @returns JavaScript Boolean that indicates if the job was run
  /// successfully. Can be false because a job is already set or being
  /// processed.
  js_value_t* runJob(std::any input, JobId id = kNoJobId) {
    return js::Boolean::create(env_, addonCpp->runJob(std::move(input), id));
  }

  /// @returns JavaScript Boolean: false when the exclusive job (e.g. finetune)
  /// is refused because inference jobs are queued or in flight.
  js_value_t* runExclusiveJob(std::any input, JobId id = kNoJobId) {
    return js::Boolean::create(
        env_, addonCpp->runExclusiveJob(std::move(input), id));
  }

  /**
   * @brief Cancels jobs asynchronously
   * @param id Optional job id. Absent cancels every in-flight and queued job
   *        (cancelAll); present cancels only that job. A scheduler that cannot
   *        map the id to a job warns and does nothing — a targeted cancel is
   *        never escalated to cancelAll.
   * @return JavaScript Promise that resolves when cancellation completes
   * @note This is a non-blocking operation that returns a future/promise
   */
  js_value_t* cancelJob(std::optional<JobId> id = std::nullopt) {
    return js::JsAsyncTask::run(env_, [addonCppRef = addonCpp, id]() {
      if (id.has_value()) {
        addonCppRef->cancelJob(*id);
      } else {
        addonCppRef->cancelAllJobs();
      }
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
