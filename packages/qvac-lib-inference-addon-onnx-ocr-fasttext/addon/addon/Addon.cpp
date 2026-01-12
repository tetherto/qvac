#include "Addon.hpp"
#include <array>
#include <vector>
#include <chrono>
#include <stdexcept>
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

// Specializations of Addon methods
namespace qvac_lib_inference_addon_cpp {

/**
 * @brief Construct a new qvac lib inference addon onnx ocr fasttext::Addon::Addon object
 * 
 * @param env : JS environment handle
 * @param pathDetector : path to the ONNX model containing the Detector
 * @param pathRecognizer : path to the ONNX model containing the Recognizer
 * @param langList : a list of languages to be supported by this model for text extraction
 * @param jsHandle : JS object pointing to the addon handle in JS
 * @param outputCb : JS function to be called on any inference event ( started, new output, error, etc )
 * @param transitionCb : JS function to be called on addon state changes (LISTENING, IDLE, STOPPED, etc)
 */
template <>
template <>
// NOLINTNEXTLINE(cppcoreguidelines-pro-type-member-init)
qvac_lib_inference_addon_onnx_ocr_fasttext::Addon::Addon(
    js_env_t* env, const ORTCHAR_T* pathDetector,
    const ORTCHAR_T* pathRecognizer, std::span<const std::string> langList,
    bool useGPU, int timeout, qvac_lib_inference_addon_onnx_ocr_fasttext::PipelineConfig config,
    js_value_t* jsThis, js_value_t* outputCallback,
    js_value_t* transitionCallback)
    : env_{env}, transitionCb_{transitionCallback},
      model_{pathDetector, pathRecognizer, langList, useGPU, timeout, config},
      jsHandle_{nullptr}, outputCb_{nullptr},
      jsOutputCallbackAsyncHandle_{nullptr}, threadsafeOutputCb_{nullptr} {
  initializeProcessingThread(env, jsThis, outputCallback, transitionCallback);
}

template<>
void qvac_lib_inference_addon_onnx_ocr_fasttext::Addon::process() {
    static constexpr auto PROCESS_WAIT_MILLISECONDS = std::chrono::milliseconds{100};
    std::unique_ptr<Job<qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline::Input>> currentJob;
    auto reset = [&]() {
      model_.reset();
      currentJob.reset();
    };

    while (running_) {
      std::unique_lock uniqueLock(mtx_);
      processCv_.wait_for(uniqueLock, PROCESS_WAIT_MILLISECONDS);

      switch (signal_) {
        case ProcessSignals::Activate:
          status_ = AddonStatus::Processing;
          break;
        case ProcessSignals::Stop:
          status_ = AddonStatus::Stopped;
          reset();
          break;
        case ProcessSignals::Pause:
          status_ = AddonStatus::Paused;
          break;
        case ProcessSignals::Cancel:
          if (currentJob && (cancelJobId_ == 0 || currentJob->id == cancelJobId_)) {
            queueOutput(ModelOutput{ OutputEvent::JobEnded, currentJob->id, model_.runtimeStats() });
            reset();
            cancelJobId_ = 0;
          }
          break;
        default:
          break;
      }
      signal_ = ProcessSignals::None;

      if (status_ == AddonStatus::Stopped || status_ == AddonStatus::Paused || status_ == AddonStatus::Loading) { continue; }

      if (currentJob == nullptr) {
        // get next job
        if (jobQueue_.empty()) {
          status_ = AddonStatus::Idle;
          continue;
        }
        currentJob = std::move(jobQueue_.top().job);
        jobQueue_.pop();
        status_ = AddonStatus::Processing;
        queueOutput(ModelOutput{ OutputEvent::JobStarted, currentJob->id });
      }

      status_ = AddonStatus::Processing;
      uniqueLock.unlock();

      try {
        auto output = model_.process(currentJob->input);
        std::scoped_lock slk{mtx_};
        queueOutput(ModelOutput{ OutputEvent::Output, currentJob->id, std::move(output) });
        queueOutput(ModelOutput{ OutputEvent::JobEnded, currentJob->id, model_.runtimeStats() });
        reset();
      } catch (const std::exception& e) {
        // Error, cancel current job
        auto jobId = currentJob->id;
        uniqueLock.lock();
        queueOutput(ModelOutput{ OutputEvent::Error, jobId, ModelOutput::Error{e.what()} });
        queueOutput(ModelOutput{ OutputEvent::JobEnded, jobId, model_.runtimeStats() });
        reset();
      }
    }
}

namespace {

js_value_t* createArrayFromElements(js_env_t* env, std::span<js_value_t *> elements) {
  js_value_t *jsArray = nullptr;
  js_create_array_with_length(env, elements.size(), &jsArray);
  js_set_array_elements(env, jsArray, const_cast<const js_value_t **>(elements.data()), elements.size(), 0);
  return jsArray;
}

js_value_t* getJsArrayFromOutput(js_env_t* env, qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline::Output &inferredTextList) {
  size_t inferredTextListLength = inferredTextList.size();
  auto jsInferredTextListElements = std::make_unique<js_value_t*[]>(inferredTextListLength); /* NOLINT(modernize-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays,hicpp-avoid-c-arrays) */

  // Populate each element of jsInferredTextListElements with an inferredText array: [bounding box, text, confidence]
  for (size_t i = 0; i < inferredTextListLength; i++) {

    // Create bounding box elements: [ [x1, y1], [x2, y2], [x3, y3], [x4, y4 ]
    constexpr size_t BOX_COORDINATES_LENGTH = 4;
    std::array<js_value_t*, BOX_COORDINATES_LENGTH> jsBoxCoordinatesElements{};
    for (size_t boxCoordinateIndex = 0; boxCoordinateIndex < BOX_COORDINATES_LENGTH; boxCoordinateIndex++) {
      constexpr size_t COORDINATE_PAIR_LENGTH = 2;
      std::array<js_value_t*, COORDINATE_PAIR_LENGTH> jsCoordinatePairElement{};
      jsCoordinatePairElement.at(0) = js::Number::create(env, inferredTextList[i].boxCoordinates.at(boxCoordinateIndex).x);
      jsCoordinatePairElement.at(1) = js::Number::create(env, inferredTextList[i].boxCoordinates.at(boxCoordinateIndex).y);
      jsBoxCoordinatesElements.at(boxCoordinateIndex) = createArrayFromElements(env, std::span{jsCoordinatePairElement});
    }

    constexpr size_t INFERRED_TEXT_LENGTH = 3;
    std::array<js_value_t*, INFERRED_TEXT_LENGTH> jsInferredTextElements{};
    jsInferredTextElements.at(0) = createArrayFromElements(env, std::span{jsBoxCoordinatesElements});
    jsInferredTextElements.at(1) = js::String::create(env, inferredTextList[i].text);
    jsInferredTextElements.at(2) = js::Number::create(env, inferredTextList[i].confidenceScore);

    jsInferredTextListElements[i] = createArrayFromElements(env, std::span{jsInferredTextElements});
  }

  return createArrayFromElements(env, std::span<js_value_t*>{jsInferredTextListElements.get(), inferredTextListLength});
}

}

template<>
void qvac_lib_inference_addon_onnx_ocr_fasttext::Addon::jsOutputCallback(uv_async_t* handle) try {
  auto& addon = *reinterpret_cast<Addon*> /* NOLINT(cppcoreguidelines-pro-type-reinterpret-cast) */(uv_handle_get_data(reinterpret_cast<uv_handle_t*> /* NOLINT(cppcoreguidelines-pro-type-reinterpret-cast) */(handle)));
  js_handle_scope_t* scope = nullptr;
  JS(js_open_handle_scope(addon.env_, &scope));
  auto scopeCleanup = utils::onExit([env=addon.env_, scope]() { js_close_handle_scope(env, scope); });
  js_value_t* outputCb = nullptr;
  JS(js_get_reference_value(addon.env_, addon.outputCb_, &outputCb));
  js_value_t* jsHandle = nullptr;
  JS(js_get_reference_value(addon.env_, addon.jsHandle_, &jsHandle));
  std::vector<ModelOutput> outputQueue;
  {
    std::scoped_lock scopedLock{ addon.mtx_ };
    outputQueue = std::move(addon.outputQueue_);
  }
  for (auto& output : outputQueue) {
    js_handle_scope_t* innerScope = nullptr;
    JS(js_open_handle_scope(addon.env_, &innerScope));
    auto scopeCleanup = utils::onExit([env = addon.env_, innerScope]() { js_close_handle_scope(env, innerScope); });
    static constexpr size_t OUTPUT_CB_PARAMETERS_COUNT = 5;
    std::array<js_value_t*, OUTPUT_CB_PARAMETERS_COUNT> outputCbParameters{
      jsHandle,
      js::String::create(addon.env_, outputEventToStringView(output.event) ),
      js::Number::create(addon.env_, output.id)
      , nullptr,
      nullptr
    };
    switch (output.event) {
      case OutputEvent::Output: {
        auto& inferredTextList = std::get<qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline::Output>(output.data);
        outputCbParameters[3] = getJsArrayFromOutput(addon.env_, inferredTextList);
        outputCbParameters[4] = js::Undefined::create(addon.env_);
      } break;
      case OutputEvent::JobStarted: {
        outputCbParameters[3] = js::Undefined::create(addon.env_);
        outputCbParameters[4] = js::Undefined::create(addon.env_);
      } break;
      case OutputEvent::JobEnded: {
          js::Object runtimeStats = js::Object::create(addon.env_);
          auto& stats = std::get<RuntimeStats>(output.data);
          
          for (auto& statPair : stats) {
            std::visit([env=addon.env_, &runtimeStats, &statPair](auto&& val) {
              runtimeStats.setProperty( env, statPair.first.c_str(), js::Number::create(env, val) );
            }, statPair.second);
          }
          outputCbParameters[3] = runtimeStats;
          outputCbParameters[4] = js::Undefined::create(addon.env_);
      } break;
      case OutputEvent::Error: {
        outputCbParameters[3] = js::Undefined::create(addon.env_);
        outputCbParameters[4] = js::String::create(addon.env_, std::get<ModelOutput::Error>(output.data).error);
      } break;
      default: { throw std::logic_error("Unhandled OutputEvent"); }
    }
    js_value_t* receiver = nullptr;
    JS(js_get_global(addon.env_, &receiver));
    JS(js_call_function(addon.env_, receiver, outputCb, OUTPUT_CB_PARAMETERS_COUNT, outputCbParameters.data(), nullptr));
  }
} catch (...) {
  auto& addon = *reinterpret_cast<Addon*> /* NOLINT(cppcoreguidelines-pro-type-reinterpret-cast) */(uv_handle_get_data(reinterpret_cast<uv_handle_t*> /* NOLINT(cppcoreguidelines-pro-type-reinterpret-cast) */(handle)));
  js_handle_scope_t* scope = nullptr;
  if (js_open_handle_scope(addon.env_, &scope) != 0) { return; }
  auto scopeCleanup = utils::onExit([env = addon.env_, scope]() { js_close_handle_scope(env, scope); });
  bool isExceptionPending = false;
  if (js_is_exception_pending(addon.env_, &isExceptionPending) != 0) { return; }
  if (isExceptionPending) {
    js_value_t* error = nullptr;
    js_get_and_clear_last_exception(addon.env_, &error);
  }
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR, "jsOutputCallback : failed");
}

template<> 
uint32_t qvac_lib_inference_addon_onnx_ocr_fasttext::Addon::append(int priority, qvac_lib_inference_addon_onnx_ocr_fasttext::PipelineInput input) {
  uint32_t jobId = 0;
  {
    std::scoped_lock lock{ mtx_ };
    auto newJob = std::make_unique<Job<qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline::Input>>(++jobIds_);
    jobId = newJob->id;
    newJob->input = std::move(input);
    static constexpr int DEFAULT_PRIORITY = 50;
    jobQueue_.emplace(priority == -1? DEFAULT_PRIORITY : priority, std::move(newJob));
  }
  processCv_.notify_one();
  return jobId;
}

}
