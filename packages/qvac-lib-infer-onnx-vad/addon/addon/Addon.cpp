#include "Addon.hpp"
#include "model-interface/SileroVadIterator.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include <functional>
#include <array>
#include <memory>
#include <algorithm>

namespace qvac_lib_inference_addon_cpp {

using Model = qvac_lib_inference_addon_onnx_silerovad::VadIterator;

namespace {
// Named constants to avoid magic numbers in constructor
constexpr int kSampleRate = 16000;
constexpr int kWindowFrameSize = 512;
constexpr float kThreshold = 0.50F;
constexpr int kMinSilenceDurationMs = 300;
constexpr int kSpeechPadMs = 64;
constexpr int kMinSpeechDurationMs = 250;
constexpr float kMaxSpeechDurationS = std::numeric_limits<float>::infinity();

inline auto createSileroVadJsObject(js_env_t* env, const Model::Output& output) -> js_value_t* {
  const size_t len = output.size() > 2 ? output.size() - 2 : 0;
  if (len == 0) {
    return js::Null::create(env);
  }

  auto bufferOwner = std::unique_ptr<Model::ValueType[]>(new Model::ValueType[len]); // NOLINT(cppcoreguidelines-avoid-c-arrays,hicpp-avoid-c-arrays,modernize-avoid-c-arrays)
  std::copy_n(output.begin(), len, bufferOwner.get());

  js_value_t* tsArrayBuffer = nullptr;
  JS(js_create_external_arraybuffer(env,
                                    static_cast<void*>(bufferOwner.release()),
                                    sizeof(Model::ValueType) * len,
                                    [](js_env_t*, void* data, void*) { delete[] static_cast<Model::ValueType*>(data); /* NOLINT(cppcoreguidelines-owning-memory) */ },
                                    nullptr,
                                    &tsArrayBuffer));

  auto inputLengthMs = js::Number::create(env, output[len]);
  auto processingTimeMs = js::Number::create(env, output[len + 1]);

  auto result = js::Object::create(env);
  result.setProperty(env, "tsArrayBuffer", tsArrayBuffer);
  result.setProperty(env, "inputLengthMs", inputLengthMs);
  result.setProperty(env, "processingTimeMs", processingTimeMs);
  return result;
}
} // namespace

template<>
auto Addon<qvac_lib_inference_addon_onnx_silerovad::VadIterator>::getNextPiece( // NOLINT(modernize-use-trailing-return-type)
  Model::Input& input,
  [[maybe_unused]] size_t lastPieceEnd) -> Model::Input {
  return input;
}

template<> template<>
Addon<qvac_lib_inference_addon_onnx_silerovad::VadIterator>::Addon(
  js_env_t* env,
  js_value_t* jsHandle,
  js_value_t* outputCb,
  [[maybe_unused]] js_value_t* transitionCb,
  std::reference_wrapper<const std::string> path
) : env_(env)
  , jsHandle_(nullptr)
  , outputCb_(nullptr)
  , transitionCb_(transitionCb)
  , jsOutputCallbackAsyncHandle_(nullptr)
  , threadsafeOutputCb_(nullptr)
  , model_(path, qvac_lib_inference_addon_onnx_silerovad::VadConfig{
      .sampleRate = kSampleRate,
      .windowFrameSize = kWindowFrameSize,
      .threshold = kThreshold,
      .minSilenceDurationMs = kMinSilenceDurationMs,
      .speechPadMs = kSpeechPadMs,
      .minSpeechDurationMs = kMinSpeechDurationMs,
      .maxSpeechDurationS = kMaxSpeechDurationS
    })
{
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
}

template<>
void Addon<qvac_lib_inference_addon_onnx_silerovad::VadIterator>::jsOutputCallback(uv_async_t* handle) try {
  auto* handleBase = reinterpret_cast<uv_handle_t*>(handle); // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* self = static_cast<Addon*>(uv_handle_get_data(handleBase));
  auto& addon = *self;
  js_handle_scope_t* scope = nullptr;
  JS(js_open_handle_scope(addon.env_, &scope));
  auto scopeCleanup = utils::onExit([env=addon.env_, scope]() { js_close_handle_scope(env, scope); });
  js_value_t* outputCb = nullptr;
  JS(js_get_reference_value(addon.env_, addon.outputCb_, &outputCb));
  js_value_t* jsHandle = nullptr;
  JS(js_get_reference_value(addon.env_, addon.jsHandle_, &jsHandle));
  std::vector<ModelOutput> outputQueue;
  {
    std::scoped_lock addonLock{ addon.mtx_ };
    outputQueue = std::move(addon.outputQueue_);
  }
  for (auto& output : outputQueue) {
    js_handle_scope_t* innerScope = nullptr;
    JS(js_open_handle_scope(addon.env_, &innerScope));
    auto scopeCleanup = utils::onExit([env = addon.env_, innerScope] () {
      js_close_handle_scope(env, innerScope);
    });

    static constexpr auto outputCbParametersCount = 5;
    std::array<js_value_t*, outputCbParametersCount> outputCbParameters{
      jsHandle,
      js::String::create(addon.env_, outputEventToStringView(output.event)),
      js::Number::create(addon.env_, output.id)
    };

    switch (output.event) {
      case OutputEvent::Output:
        outputCbParameters[3] = createSileroVadJsObject(addon.env_,
                                                        std::get<Model::Output>(output.data));
        outputCbParameters[4] = js::Undefined::create(addon.env_);
        break;
      case OutputEvent::JobStarted:
        outputCbParameters[3] = js::Undefined::create(addon.env_);
        outputCbParameters[4] = js::Undefined::create(addon.env_);
        break;
      case OutputEvent::JobEnded: {
        auto runtimeStats = js::Object::create(addon.env_);
        auto& stats = std::get<RuntimeStats>(output.data);

        for (auto& statEntry : stats) {
          std::visit([env=addon.env_, &runtimeStats, &statEntry](auto&& val) {
            runtimeStats.setProperty( env, statEntry.first.c_str(), js::Number::create(env, val) );
          }, statEntry.second);
        }

        outputCbParameters[3] = runtimeStats;
        outputCbParameters[4] = js::Undefined::create(addon.env_);
        }
        break;

      case OutputEvent::Error:
        outputCbParameters[3] = js::Undefined::create(addon.env_);
        outputCbParameters[4] = createSileroVadJsObject(
          addon.env_,
          std::get<Model::Output>(output.data)
        );
        break;
      case OutputEvent::LogMsg:
        outputCbParameters[3] = js::String::create(addon.env_, std::get<ModelOutput::LogMsg>(output.data).msg);
        outputCbParameters[4] = js::Undefined::create(addon.env_);
        break;
      default:
        outputCbParameters[3] = js::Undefined::create(addon.env_);
        outputCbParameters[4] = js::Undefined::create(addon.env_);
        break;
    }
    js_value_t* receiver = nullptr;
    JS(js_get_global(addon.env_, &receiver));
    JS(js_call_function(addon.env_, receiver, outputCb, outputCbParameters.size(), outputCbParameters.data(), nullptr));
  }
} catch (...) {
  auto* handleBase = reinterpret_cast<uv_handle_t*>(handle); // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* self = static_cast<Addon*>(uv_handle_get_data(handleBase));
  auto& addon = *self;
  js_handle_scope_t* scope = nullptr;
  if (js_open_handle_scope(addon.env_, &scope) != 0) { return; }
  auto scopeCleanup = utils::onExit([env = addon.env_, scope]() { js_close_handle_scope(env, scope); });
  bool isExceptionPending = false;
  if (js_is_exception_pending(addon.env_, &isExceptionPending) != 0) { return; }
  if (isExceptionPending) {
    js_value_t* error = nullptr;
    js_get_and_clear_last_exception(addon.env_, &error);
  }
  std::cout << "jsOutputCallback : failed\n";
}

template<>
void Addon<qvac_lib_inference_addon_onnx_silerovad::VadIterator>::process() { // NOLINT(readability-function-cognitive-complexity)
  std::unique_ptr<Job<Model::Input>> currentJob;
  auto cleanupLastAppended = utils::onError([&currentJob, this] () {
    auto lockGuard = std::scoped_lock{ mtx_ };

    if (currentJob.get() == lastAppendedJob_) {
      lastAppendedJob_ = nullptr;
    }
  });

  Model::Input input;
  size_t lastPieceEnd = 0;
  static constexpr int kProcessWaitMs = 100;
  while (running_) {
    std::unique_lock lock(mtx_);
    processCv_.wait_for(lock, std::chrono::milliseconds{ kProcessWaitMs });

    if (signal_ != ProcessSignals::None) {
      switch (signal_) {
        case ProcessSignals::Activate:
          status_ = AddonStatus::Processing;
          break;
        case ProcessSignals::UnloadWeights:
        case ProcessSignals::Unload:
        case ProcessSignals::Load:
        case ProcessSignals::Reload:
        case ProcessSignals::Finetune:
          // Not supported in this specialization
          break;
        case ProcessSignals::Stop:
          status_ = AddonStatus::Stopped;
          model_.reset();
          if (currentJob && currentJob.get() == lastAppendedJob_) {
            lastAppendedJob_ = nullptr;
          }
          currentJob.reset();
          input.clear();
          break;
        case ProcessSignals::Pause:
          status_ = AddonStatus::Paused;
          break;
        case ProcessSignals::Cancel:
          if (currentJob && (cancelJobId_ == 0 || currentJob->id == cancelJobId_)) {
            queueOutput(ModelOutput{ OutputEvent::JobEnded, currentJob->id, model_.runtimeStats() });
            model_.reset();
            if (currentJob.get() == lastAppendedJob_) {
              lastAppendedJob_ = nullptr;
            }
            currentJob.reset();
            cancelJobId_ = 0;
            input.clear();
          }
          break;
        case ProcessSignals::None:
        default:
          break;
      }
      signal_ = ProcessSignals::None;
    }

    if (status_ == AddonStatus::Stopped
        || status_ == AddonStatus::Paused
        || status_ == AddonStatus::Loading) {
      continue;
    }

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

    if (input.empty()) {
      // grab next chunk of input
      if (currentJob->input.empty()) {
        // no more input, check if end of job
        if (currentJob.get() != lastAppendedJob_) {
          // job ended
          queueOutput(ModelOutput{ OutputEvent::JobEnded, currentJob->id, model_.runtimeStats() });
          model_.reset();
          currentJob.reset();

          continue;
        }
        // wait for more input
        status_ = AddonStatus::Listening;
        continue;
      }
      std::swap(input, currentJob->input);
      lastPieceEnd = 0;
      status_ = AddonStatus::Processing;
    }
    lock.unlock();
    // process input in small pieces
    auto piece = getNextPiece(input, lastPieceEnd);

    lastPieceEnd += piece.size();
    if (lastPieceEnd == input.size()) {
      input.clear();
    }

    try {
      {
        model_.process(piece);
        std::scoped_lock slk{mtx_};
        queueOutput(ModelOutput{ OutputEvent::Output, currentJob->id, std::move(piece) });
      }
    } catch (const std::exception& e) {
      // Error, cancel current job
      auto jobId = currentJob->id;
      lock.lock();

      queueOutput(ModelOutput{ OutputEvent::Error, jobId,  });
      queueOutput(ModelOutput{ OutputEvent::JobEnded, jobId, model_.runtimeStats() });
      model_.reset();

      if (currentJob.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
      }

      currentJob.reset();
      input.clear();
    }
  }
}

}
