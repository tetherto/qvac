#pragma once

// NOTE: Do not include <js.h> here to avoid pollution of C++ interface. Please
// use AddonJs instead.
#include <functional>
#include <memory>

#include "../JobRunner.hpp"
#include "../Logger.hpp"
#include "../ModelInterfaces.hpp"
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
  JobRunner jobRunner_;

public:
  /**
   * @brief Constructor for the Addon class
   * @param outputCallback Output callback to handle results
   * @param model Model interface implementation
   */
  AddonCpp(
      std::unique_ptr<OutputCallBackInterface>&& outputCallback,
      std::unique_ptr<model::IModel>&& model)
      : model_(std::move(model)), outputCallback_(std::move(outputCallback)),
        outputQueue(std::make_shared<OutputQueue>(*outputCallback_, *model_)),
        jobRunner_(
            outputQueue, model_.get(),
            dynamic_cast<model::IModelCancel*>(model_.get())),
        model(*this->model_),
        asyncLoad(dynamic_cast<model::IModelAsyncLoad*>(model_.get())) {
    outputCallback_->initializeProcessingThread(outputQueue);
    jobRunner_.start();
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

  /// @returns False if the job cannot be run (e.g. because a job is already set or being processed)
  bool runJob(std::any input) { return jobRunner_.runJob(std::move(input)); }
  void cancelJob(std::optional<JobId> jobId = std::nullopt) {
    jobRunner_.cancel(jobId);
  }

  const std::reference_wrapper<model::IModel> model;
  model::IModelAsyncLoad* const asyncLoad;
};

} // namespace qvac_lib_inference_addon_cpp
