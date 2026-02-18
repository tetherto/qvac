#include "Addon.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <iostream>
#include <ranges>

#include "js.h"
#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"
#include "qvac-lib-inference-addon-cpp/JsLogger.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "qvac-lib-inference-addon-cpp/Utils.hpp"
#include "uv.h"

namespace qvac_lib_inference_addon_cpp {

using Priority = qvac_lib_inference_addon_cpp::logger::Priority;
using Model = qvac_lib_infer_parakeet::ParakeetModel;
using ParakeetAddon = Addon<Model>;

// Specialize getNextPiece - return the full input (no chunking for Parakeet)
template <>
auto ParakeetAddon::getNextPiece(Model::Input& input, size_t /*lastPieceEnd*/)
    -> Model::Input {
  return input;
}

// Constructor specialization - const reference version
template <>
template <>
ParakeetAddon::Addon(
    js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
    js_value_t* transitionCb,
    const qvac_lib_infer_parakeet::ParakeetConfig& parakeetConfig,
    bool /*enableStats*/)
    : env_{env}, jsHandle_{nullptr}, outputCb_{nullptr},
      transitionCb_{transitionCb}, jsOutputCallbackAsyncHandle_{nullptr},
      threadsafeOutputCb_{nullptr}, model_{parakeetConfig} {
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
}

// Constructor specialization - by value version (needed when passing temporaries)
// NOLINTNEXTLINE(performance-unnecessary-value-param)
template <>
template <>
ParakeetAddon::Addon(
    js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
    js_value_t* transitionCb,
    qvac_lib_infer_parakeet::ParakeetConfig parakeetConfig,
    bool /*enableStats*/)
    : env_{env}, jsHandle_{nullptr}, outputCb_{nullptr},
      transitionCb_{transitionCb}, jsOutputCallbackAsyncHandle_{nullptr},
      threadsafeOutputCb_{nullptr}, model_{parakeetConfig} {
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
}

// Custom jsOutputCallback for Parakeet output format
template <>
auto ParakeetAddon::jsOutputCallback(uv_async_t* handle) -> void try {
  // Convert Parakeet output to JavaScript consumable format
  auto parakeetOutputToJsConsumable =
      [](js_env_t* env, const Model::Output& output) -> js_value_t* {
    js_value_t* outputArr = nullptr;
    js_create_array_with_length(env, output.size(), &outputArr);

    for (size_t i = 0; i < output.size(); ++i) {
      js::Object obj = js::Object::create(env);

      if (!output[i].text.empty()) {
        obj.setProperty(env, "text", js::String::create(env, output[i].text));
        obj.setProperty(
            env, "toAppend", js::Boolean::create(env, output[i].toAppend));
        obj.setProperty(env, "start", js::Number::create(env, output[i].start));
        obj.setProperty(env, "end", js::Number::create(env, output[i].end));
        obj.setProperty(
            env,
            "id",
            js::Number::create(env, static_cast<uint64_t>(output[i].id)));
      }

      js_set_element(env, outputArr, i, obj);
    }

    return outputArr;
  };

  auto* asHandle = reinterpret_cast<uv_handle_t*>(handle);
  auto& addon = *static_cast<ParakeetAddon*>(uv_handle_get_data(asHandle));

  js_handle_scope_t* scope = nullptr;
  JS(js_open_handle_scope(addon.env_, &scope));
  auto scopeCleanup = utils::onExit(
      [env = addon.env_, scope]() { js_close_handle_scope(env, scope); });

  js_value_t* outputCb = nullptr;
  JS(js_get_reference_value(addon.env_, addon.outputCb_, &outputCb));

  js_value_t* jsHandle = nullptr;
  JS(js_get_reference_value(addon.env_, addon.jsHandle_, &jsHandle));

  std::vector<ModelOutput> outputQueue;
  {
    std::scoped_lock outputQueueLock{addon.mtx_};
    outputQueue = std::move(addon.outputQueue_);
  }

  for (auto& output : outputQueue) {
    js_handle_scope_t* innerScope = nullptr;
    JS(js_open_handle_scope(addon.env_, &innerScope));
    auto innerScopeCleanup = utils::onExit([env = addon.env_, innerScope]() {
      js_close_handle_scope(env, innerScope);
    });

    static constexpr std::size_t K_OUTPUT_CB_PARAMETERS_COUNT = 5;
    std::array<js_value_t*, K_OUTPUT_CB_PARAMETERS_COUNT> outputCbParameters{
        jsHandle,
        js::String::create(addon.env_, outputEventToStringView(output.event)),
        js::Number::create(addon.env_, output.id),
        nullptr,
        nullptr};

    switch (output.event) {
    case OutputEvent::Output:
      outputCbParameters[3] = parakeetOutputToJsConsumable(
          addon.env_, std::get<Model::Output>(output.data));
      outputCbParameters[4] = js::Undefined::create(addon.env_);
      break;
    case OutputEvent::JobStarted:
      outputCbParameters[3] = js::Undefined::create(addon.env_);
      outputCbParameters[4] = js::Undefined::create(addon.env_);
      break;
    case OutputEvent::JobEnded: {
      auto& stats = std::get<RuntimeStats>(output.data);
      js::Object runtimeStats = js::Object::create(addon.env_);
      for (auto& stat : stats) {
        std::visit(
            [env = addon.env_, &runtimeStats, &stat](auto&& val) {
              runtimeStats.setProperty(
                  env, stat.first.c_str(), js::Number::create(env, val));
            },
            stat.second);
      }
      outputCbParameters[3] = runtimeStats;
      outputCbParameters[4] = js::Undefined::create(addon.env_);
      break;
    }
    case OutputEvent::Error:
      outputCbParameters[3] = js::Undefined::create(addon.env_);
      outputCbParameters[4] = js::String::create(
          addon.env_, std::get<typename ModelOutput::Error>(output.data).error);
      break;
    default:
      break;
    }

    js_value_t* receiver = nullptr;
    JS(js_get_global(addon.env_, &receiver));
    JS(js_call_function(
        addon.env_,
        receiver,
        outputCb,
        static_cast<int>(outputCbParameters.size()),
        outputCbParameters.data(),
        nullptr));
  }
} catch (...) {
  auto* asHandle = reinterpret_cast<uv_handle_t*>(handle);
  auto& addon = *static_cast<ParakeetAddon*>(uv_handle_get_data(asHandle));

  js_handle_scope_t* scope = nullptr;
  if (js_open_handle_scope(addon.env_, &scope) != 0) {
    return;
  }
  auto scopeCleanup = utils::onExit(
      [env = addon.env_, scope]() { js_close_handle_scope(env, scope); });

  bool isExceptionPending = false;
  if (js_is_exception_pending(addon.env_, &isExceptionPending) != 0) {
    return;
  }
  if (isExceptionPending) {
    js_value_t* error = nullptr;
    js_get_and_clear_last_exception(addon.env_, &error);
  }
  logger::JsLogger::log(Priority::ERROR, "jsOutputCallback : failed");
}

// Custom process loop for Parakeet
template <>
void ParakeetAddon::process() {
  Model::Input input;
  auto cleanupLastAppended = utils::onError([this]() {
    auto l = std::scoped_lock{mtx_};
    if (currentJob_.get() == lastAppendedJob_) {
      lastAppendedJob_ = nullptr;
    }
  });

  size_t lastPieceEnd = 0;

  while (running_) {
    std::unique_lock lk(mtx_);
    processCv_.wait_for(lk, std::chrono::milliseconds{100});

    // Handle signals
    switch (signal_) {
    case ProcessSignals::Activate:
      if (!model_.isLoaded()) {
        QLOG(Priority::DEBUG, "Activating addon: loading model");
        try {
          model_.load();
        } catch (const std::exception &e) {
          QLOG(Priority::ERROR,
               std::string("Failed to load model: ") + e.what());
          // Emit error to JavaScript
          queueOutput(ModelOutput{OutputEvent::Error, 0,
                                  typename ModelOutput::Error{e.what()}});
          status_ = AddonStatus::Idle;
          signal_ = ProcessSignals::None;
          continue;
        }
      }
      status_ = AddonStatus::Processing;
      break;
    case ProcessSignals::UnloadWeights:
      status_ = AddonStatus::Loading;
      if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
      }
      currentJob_.reset();
      input.clear();
      model_.unloadWeights();
      break;
    case ProcessSignals::Unload:
      QLOG(Priority::DEBUG, "Unloading addon");
      status_ = AddonStatus::Unloaded;
      if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
      }
      currentJob_.reset();
      input.clear();
      model_.unload();
      break;
    case ProcessSignals::Load:
      QLOG(Priority::DEBUG, "Loading addon");
      status_ = AddonStatus::Loading;
      if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
      }
      currentJob_.reset();
      input.clear();
      try {
        model_.load();
      } catch (const std::exception &e) {
        QLOG(Priority::ERROR, std::string("Failed to load model: ") + e.what());
        // Emit error to JavaScript
        queueOutput(ModelOutput{OutputEvent::Error, 0,
                                typename ModelOutput::Error{e.what()}});
        status_ = AddonStatus::Idle;
        signal_ = ProcessSignals::None;
        continue;
      }
      break;
    case ProcessSignals::Stop:
      status_ = AddonStatus::Stopped;
      if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
      }
      currentJob_.reset();
      input.clear();
      model_.reset();
      break;
    case ProcessSignals::Pause:
      status_ = AddonStatus::Paused;
      break;
    case ProcessSignals::Cancel:
      if (currentJob_ &&
          (cancelJobId_ == 0 || currentJob_->id == cancelJobId_)) {
        QLOG(Priority::DEBUG, "Cancelling job " + std::to_string(currentJob_->id));
        queueOutput(ModelOutput{
            OutputEvent::JobEnded, currentJob_->id, model_.runtimeStats()});
        model_.reset();
        if (currentJob_.get() == lastAppendedJob_) {
          lastAppendedJob_ = nullptr;
        }
        currentJob_.reset();
        input.clear();
        cancelJobId_ = 0;
      }
      break;
    case ProcessSignals::None:
    default:
      break;
    }
    signal_ = ProcessSignals::None;

    // Skip processing in certain states
    constexpr std::array kSkipStatuses = {
        AddonStatus::Stopped, AddonStatus::Paused, AddonStatus::Loading,
        AddonStatus::Unloaded};
    if (std::ranges::find(kSkipStatuses, status_) != kSkipStatuses.end()) {
      continue;
    }

    // Prepare job for processing
    if (currentJob_ == nullptr) {
      if (jobQueue_.empty()) {
        if (status_ != AddonStatus::Idle) {
          QLOG(Priority::DEBUG, "Job queue empty, setting status to Idle");
        }
        status_ = AddonStatus::Idle;
        continue;
      }
      currentJob_ = std::move(jobQueue_.top().job);
      jobQueue_.pop();
      
      QLOG(Priority::DEBUG, "Starting job " + std::to_string(currentJob_->id));
      
      status_ = AddonStatus::Processing;
      queueOutput(ModelOutput{OutputEvent::JobStarted, currentJob_->id});
    }

    if (input.empty()) {
      if (currentJob_->input.empty()) {
        if (currentJob_.get() != lastAppendedJob_) {
          QLOG(Priority::DEBUG, "Job " + std::to_string(currentJob_->id) + " completed");
          
          queueOutput(ModelOutput{
              OutputEvent::JobEnded, currentJob_->id, model_.runtimeStats()});
          model_.reset();
          currentJob_.reset();
          continue;
        }
        status_ = AddonStatus::Listening;
        continue;
      }
      std::swap(input, currentJob_->input);
      lastPieceEnd = 0;
      status_ = AddonStatus::Processing;
    }

    lk.unlock();

    // Process input
    auto piece = getNextPiece(input, lastPieceEnd);
    lastPieceEnd += piece.size();
    if (lastPieceEnd == input.size()) {
      input.clear();
    }

    try {
      // Use the process overload that returns Output via callback
      Model::Output modelOutput;
      modelOutput = model_.process(piece, [&modelOutput](const Model::Output& out) {
        modelOutput = out;
      });
      
      std::scoped_lock outputLock{mtx_};
      queueOutput(
          ModelOutput{OutputEvent::Output, currentJob_->id, std::move(modelOutput)});
    } catch (const std::exception& e) {
      auto jobId = currentJob_->id;
      std::scoped_lock errorLock{mtx_};
      
      QLOG(Priority::ERROR,
           "Error processing job " + std::to_string(jobId) + ": " + e.what());
      
      queueOutput(ModelOutput{
          OutputEvent::Error, jobId, typename ModelOutput::Error{e.what()}});
      queueOutput(
          ModelOutput{OutputEvent::JobEnded, jobId, model_.runtimeStats()});
      model_.reset();
      if (currentJob_.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
      }
      currentJob_.reset();
      input.clear();
    }
  }
}

// Custom endOfJob for Parakeet
template <>
uint32_t ParakeetAddon::endOfJob() {
  model_.endOfStream();

  uint32_t jobId = 0;
  if (lastAppendedJob_ != nullptr) {
    jobId = lastAppendedJob_->id;
    // Only emit JobEnded immediately if not currently processing
    // (if processing, the processing loop will emit it when done)
    if (status_ != AddonStatus::Processing) {
      queueOutput(Output<Model::Output>{
          OutputEvent::JobEnded, lastAppendedJob_->id, model_.runtimeStats()});
    }
    // Always clear lastAppendedJob_ so the processing loop knows the job is finished
    lastAppendedJob_ = nullptr;
  }

  return jobId;
}

} // namespace qvac_lib_inference_addon_cpp
