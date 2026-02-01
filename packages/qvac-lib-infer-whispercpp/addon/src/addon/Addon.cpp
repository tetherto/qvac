#include "Addon.hpp"

#include <array>

#include <model-interface/whisper.cpp/WhisperConfig.hpp>

#include "WhisperModelJobsHandler.hpp"
#include "js.h"
#include "model-interface/WhisperTypes.hpp"
#include "model-interface/whisper.cpp/WhisperModel.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "qvac-lib-inference-addon-cpp/Utils.hpp"
#include "uv.h"

namespace qvac_lib_inference_addon_cpp {

using Priority = qvac_lib_inference_addon_cpp::logger::Priority;
using JsLogger = qvac_lib_inference_addon_cpp::logger::JsLogger;
using Model = qvac_lib_inference_addon_whisper::WhisperModel;

template <>
// NOLINTNEXTLINE(modernize-use-trailing-return-type)
auto qvac_lib_inference_addon_whisper::Addon::getNextPiece(
    Model::Input& input, size_t /*lastPieceEnd*/) -> Model::Input {
  return input;
}

template <>
template <>
qvac_lib_inference_addon_whisper::Addon::Addon(
    js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
    js_value_t* transitionCb,
    const qvac_lib_inference_addon_whisper::WhisperConfig& whisperConfig,
    bool enableStats)
    : env_{env}, jsHandle_{nullptr}, outputCb_{nullptr},
      transitionCb_{transitionCb}, jsOutputCallbackAsyncHandle_{nullptr},
      threadsafeOutputCb_{nullptr}, model_{whisperConfig} {
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
}

// Provide explicit specialization that takes WhisperConfig by value to satisfy
// linker NOLINTNEXTLINE(performance-unnecessary-value-param)
template <>
template <>
qvac_lib_inference_addon_whisper::Addon::Addon(
    js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
    js_value_t* transitionCb,
    qvac_lib_inference_addon_whisper::WhisperConfig
        whisperConfig, // NOLINT(performance-unnecessary-value-param)
    bool enableStats)
    : env_{env}, jsHandle_{nullptr}, outputCb_{nullptr},
      transitionCb_{transitionCb}, jsOutputCallbackAsyncHandle_{nullptr},
      threadsafeOutputCb_{nullptr}, model_{whisperConfig} {
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
}

template <>
auto
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
qvac_lib_inference_addon_whisper::Addon::jsOutputCallback(uv_async_t* handle)
    -> void try {
  auto whisperTinyOutputToJsConsumable =
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

  auto* asHandle = reinterpret_cast<uv_handle_t*>(
      handle); // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  auto& addon = *static_cast<Addon*>(uv_handle_get_data(asHandle));
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
    auto scopeCleanup = utils::onExit([env = addon.env_, innerScope]() {
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
      outputCbParameters[3] = whisperTinyOutputToJsConsumable(
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
  auto* asHandle = reinterpret_cast<uv_handle_t*>(
      handle); // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  auto& addon = *static_cast<Addon*>(uv_handle_get_data(asHandle));
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
  JsLogger::log(Priority::ERROR, "jsOutputCallback : failed");
}

template <> void qvac_lib_inference_addon_whisper::Addon::process() {
  std::unique_ptr<Job<typename Model::Input>> currentJob;
  typename Model::Input input;

  auto* handler = WhisperModelJobsHandler::getInstance();
  std::function<void(const Output<typename Model::Output>&)> queueOutputFunc =
      [this](const Output<typename Model::Output>& output) {
        this->queueOutput(
            std::move(const_cast<Output<typename Model::Output>&>(output)));
      };

  handler->process(
      currentJob,
      input,
      model_,
      jobQueue_,
      lastAppendedJob_,
      status_,
      queueOutputFunc,
      running_,
      mtx_,
      processCv_);
}

template <> uint32_t qvac_lib_inference_addon_whisper::Addon::endOfJob() {
  model_.endOfStream();

  uint32_t jobId = 0;
  // Manually trigger JobEnded event since the callback approach may not work
  // reliably This ensures we always get a JobEnded response
  if (lastAppendedJob_ != nullptr && status_ != AddonStatus::Processing) {
    jobId = lastAppendedJob_->id;
    queueOutput(Output<typename Model::Output>{
        OutputEvent::JobEnded, lastAppendedJob_->id, model_.runtimeStats()});

    // Reset the job
    lastAppendedJob_ = nullptr;
  }

  return jobId;
}

template <>
template <>
void Addon<qvac_lib_inference_addon_whisper::WhisperModel>::reload(
    const qvac_lib_inference_addon_whisper::WhisperConfig& whisperConfig) {
  {
    std::scoped_lock lockGuard{mtx_};

    if (!(status_ == AddonStatus::Idle || status_ == AddonStatus::Stopped)) {

      auto statusString = std::string(
          qvac_lib_inference_addon_cpp::addonStatusToStringView(status_));
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Addon is not in the Idle or Stopped state it is: " + statusString);
    }

    model_.setConfig(whisperConfig);
  }
}

} // namespace qvac_lib_inference_addon_cpp
