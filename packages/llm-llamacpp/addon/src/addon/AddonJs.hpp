#pragma once
#include <algorithm>
#include <any>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
#include <os/proc.h>
#endif
#endif

#include <common/arg.h>
#include <common/common.h>
#include <common/fit.h>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/job/MultiJobScheduler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <inference-addon-cpp/queue/QueueCallbacks.hpp>

#include "addon/JsBatchIds.hpp"
#include "addon/PayloadHandler.hpp"
#include "handlers/FinetuneParamHandlers.hpp"
#include "handlers/GenerationParamHandlers.hpp"
#include "model-interface/LlamaFinetuningParams.hpp"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/SpeculativeRuntime.hpp"
#include "utils/AppMemoryBudget.hpp"
#include "utils/ParallelLimits.hpp"
#include "utils/ParseUnsigned.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

/// JS event-name baked into batch payloads; must match `addon.js`
/// (`rawData.type === 'batch_output'`). Namespace-scope with linkage is
/// required to use it as a `const char*` template arg in `PayloadHandler`.
inline constexpr char BATCH_OUTPUT_TYPE_NAME[] = "batch_output";

inline LlamaModel*
tryGetLlamaModel(qvac_lib_inference_addon_cpp::AddonCpp& addonCpp) {
  return dynamic_cast<LlamaModel*>(&addonCpp.model.get());
}

inline LlamaModel*
getLlamaModel(qvac_lib_inference_addon_cpp::AddonJs& instance) {
  using namespace qvac_lib_inference_addon_cpp;
  auto* llamaModel = tryGetLlamaModel(*instance.addonCpp);
  if (llamaModel == nullptr) {
    throw StatusError(
        general_error::InternalError, "Model is not a LlamaModel");
  }
  return llamaModel;
}

struct JsFinetuneProgressOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          llama_finetuning_helpers::FinetuneProgressStats> {
  JsFinetuneProgressOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            llama_finetuning_helpers::FinetuneProgressStats>(
            [this](const llama_finetuning_helpers::FinetuneProgressStats& stats)
                -> js_value_t* {
              js::Object payload = js::Object::create(this->env_);
              payload.setProperty(
                  this->env_,
                  "type",
                  js::String::create(this->env_, "finetune_progress"));
              js::Object statsObj = js::Object::create(this->env_);
              statsObj.setProperty(
                  this->env_,
                  "is_train",
                  js::Boolean::create(this->env_, stats.isTrain));
              statsObj.setProperty(
                  this->env_,
                  "loss",
                  js::Number::create(this->env_, stats.loss));
              statsObj.setProperty(
                  this->env_,
                  "loss_uncertainty",
                  js::Number::create(this->env_, stats.lossUncertainty));
              statsObj.setProperty(
                  this->env_,
                  "accuracy",
                  js::Number::create(this->env_, stats.accuracy));
              statsObj.setProperty(
                  this->env_,
                  "accuracy_uncertainty",
                  js::Number::create(this->env_, stats.accuracyUncertainty));
              statsObj.setProperty(
                  this->env_,
                  "global_steps",
                  js::Number::create(
                      this->env_, static_cast<double>(stats.globalSteps)));
              statsObj.setProperty(
                  this->env_,
                  "current_epoch",
                  js::Number::create(
                      this->env_, static_cast<double>(stats.currentEpoch)));
              statsObj.setProperty(
                  this->env_,
                  "current_batch",
                  js::Number::create(
                      this->env_, static_cast<double>(stats.currentBatch)));
              statsObj.setProperty(
                  this->env_,
                  "total_batches",
                  js::Number::create(
                      this->env_, static_cast<double>(stats.totalBatches)));
              statsObj.setProperty(
                  this->env_,
                  "elapsed_ms",
                  js::Number::create(
                      this->env_, static_cast<double>(stats.elapsedMs)));
              statsObj.setProperty(
                  this->env_,
                  "eta_ms",
                  js::Number::create(
                      this->env_, static_cast<double>(stats.etaMs)));
              payload.setProperty(this->env_, "stats", statsObj);
              return payload;
            }) {}
};

struct JsFinetuneTerminalOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          FinetuneTerminalResult> {
  JsFinetuneTerminalOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            FinetuneTerminalResult>(
            [this](const FinetuneTerminalResult& result) -> js_value_t* {
              js::Object payload = js::Object::create(this->env_);
              payload.setProperty(
                  this->env_, "op", js::String::create(this->env_, result.op));
              payload.setProperty(
                  this->env_,
                  "status",
                  js::String::create(this->env_, result.status));
              if (result.stats.has_value()) {
                js::Object statsObj = js::Object::create(this->env_);
                statsObj.setProperty(
                    this->env_,
                    "train_loss",
                    js::Number::create(this->env_, result.stats->trainLoss));
                statsObj.setProperty(
                    this->env_,
                    "train_loss_uncertainty",
                    js::Number::create(
                        this->env_, result.stats->trainLossUncertainty));
                statsObj.setProperty(
                    this->env_,
                    "val_loss",
                    js::Number::create(this->env_, result.stats->valLoss));
                statsObj.setProperty(
                    this->env_,
                    "val_loss_uncertainty",
                    js::Number::create(
                        this->env_, result.stats->valLossUncertainty));
                statsObj.setProperty(
                    this->env_,
                    "train_accuracy",
                    js::Number::create(
                        this->env_, result.stats->trainAccuracy));
                statsObj.setProperty(
                    this->env_,
                    "train_accuracy_uncertainty",
                    js::Number::create(
                        this->env_, result.stats->trainAccuracyUncertainty));
                statsObj.setProperty(
                    this->env_,
                    "val_accuracy",
                    js::Number::create(this->env_, result.stats->valAccuracy));
                statsObj.setProperty(
                    this->env_,
                    "val_accuracy_uncertainty",
                    js::Number::create(
                        this->env_, result.stats->valAccuracyUncertainty));
                statsObj.setProperty(
                    this->env_,
                    "learning_rate",
                    js::Number::create(this->env_, result.stats->learningRate));
                statsObj.setProperty(
                    this->env_,
                    "global_steps",
                    js::Number::create(
                        this->env_,
                        static_cast<double>(result.stats->globalSteps)));
                statsObj.setProperty(
                    this->env_,
                    "epochs_completed",
                    js::Number::create(
                        this->env_,
                        static_cast<double>(result.stats->epochsCompleted)));
                payload.setProperty(this->env_, "stats", statsObj);
              }
              return payload;
            }) {}
};

/// Handler for streamed batch tokens. Reuses the per-sequence payload
/// (see `PayloadHandler`), writing only `output` per token and releasing
/// it on `finished`.
struct JsBatchTokenOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          BatchTokenOutput> {
  JsBatchTokenOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            BatchTokenOutput>(
            [this](const BatchTokenOutput& evt) -> js_value_t* {
              if (evt.payloadHandle == nullptr) {
                return js::Undefined::create(this->env_);
              }
              if (evt.finished) {
                PayloadHandler::release(this->env_, evt.payloadHandle);
                return js::Undefined::create(this->env_);
              }
              // Reuse the pre-allocated payload; only `output` changes.
              js::Object payload =
                  PayloadHandler::resolve(this->env_, evt.payloadHandle);
              payload.setProperty(
                  this->env_,
                  "output",
                  js::String::create(this->env_, evt.output));
              return payload;
            }) {}
};

inline LlamaFinetuningParams
parseLlamaFinetuningParams(js_env_t* env, js::Object& jsObj) {
  LlamaFinetuningParams params;
  params.outputParametersDir =
      jsObj.getProperty<js::String>(env, "outputParametersDir")
          .as<std::string>(env);
  params.trainDatasetDir = jsObj.getProperty<js::String>(env, "trainDatasetDir")
                               .as<std::string>(env);
  applyFinetuneParamHandlers(env, jsObj, params);
  return params;
}

inline void parseGenerationParams(
    js_env_t* env, js::Object& inputObj, LlamaModel::Prompt& prompt) {
  auto configObj =
      inputObj.getOptionalProperty<js::Object>(env, "generationParams");
  if (!configObj.has_value()) {
    return;
  }
  applyGenerationParamHandlers(env, *configObj, prompt.generationParams);
}

inline std::vector<std::pair<std::string, js::Object>>
parseInputArray(js_env_t* env, js::Array inputsArray) {
  std::vector<std::pair<std::string, js::Object>> inputs;
  const uint32_t inputCount = inputsArray.size(env);
  inputs.reserve(inputCount);
  for (uint32_t i = 0; i < inputCount; ++i) {
    auto inputObj = inputsArray.get<js::Object>(env, i);
    auto type =
        inputObj.getProperty<js::String>(env, "type").as<std::string>(env);
    inputs.emplace_back(std::move(type), inputObj);
  }
  return inputs;
}

inline LlamaModel::Prompt parsePromptInputs(
    js_env_t* env, std::vector<std::pair<std::string, js::Object>>& inputs,
    std::function<void(const std::string&)>&& outputCallback) {
  using namespace qvac_lib_inference_addon_cpp;

  LlamaModel::Prompt prompt;
  prompt.outputCallback = std::move(outputCallback);

  auto parseText = [&](js::Object& inputObj) {
    if (!prompt.input.empty()) {
      throw StatusError(
          general_error::InvalidArgument, "Only one text input is allowed");
    }
    prompt.input =
        js::String(env, inputObj.getProperty<js::String>(env, "input"))
            .as<std::string>(env);
    prompt.prefill =
        inputObj.getOptionalPropertyAs<js::Boolean, bool>(env, "prefill")
            .value_or(false);
    parseGenerationParams(env, inputObj, prompt);
    prompt.cacheKey =
        inputObj.getOptionalPropertyAs<js::String, std::string>(env, "cacheKey")
            .value_or("");
    prompt.ephemeral =
        inputObj.getOptionalPropertyAs<js::Boolean, bool>(env, "ephemeral")
            .value_or(false);
  };

  auto parseMedia = [&](js::Object& inputObj) {
    std::vector<uint8_t> mediaBytes =
        js::TypedArray<uint8_t>(
            env, inputObj.getProperty<js::TypedArray<uint8_t>>(env, "content"))
            .as<std::vector<uint8_t>>(env);
    prompt.media.push_back(std::move(mediaBytes));
  };

  for (auto& input : inputs) {
    if (input.first == "text") {
      parseText(input.second);
    } else if (input.first == "media") {
      parseMedia(input.second);
    } else {
      throw StatusError(
          general_error::InvalidArgument, "Unknown input type: " + input.first);
    }
  }

  if (prompt.input.empty() && prompt.media.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "At least one of text or media input is required");
  }

  return prompt;
}

inline std::vector<LlamaModel::Prompt> parseBatchInputs(
    js_env_t* env, qvac_lib_inference_addon_cpp::AddonJs& instance,
    js::Array batchArray, JsBatchIds& batchIds) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  vector<LlamaModel::Prompt> prompts;
  const uint32_t batchSize = batchArray.size(env);
  if (batchSize == 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "Batch input must be a non-empty array");
  }
  prompts.reserve(batchSize);

  for (uint32_t i = 0; i < batchSize; ++i) {
    auto item = batchArray.get<js::Object>(env, i);
    const string& id = batchIds.resolveAndTrack(env, item);
    auto messages = item.getProperty<js::Array>(env, "messages");
    auto inputs = parseInputArray(env, messages);

    auto queue = instance.addonCpp->outputQueue;
    // Owning handle: when every copy of `outputCallback` is dropped (slot
    // finished, cancelled, errored or scheduler torn down), the deleter
    // fires and enqueues a `finished` event so the JS handler runs
    // `PayloadHandler::release` on the JS thread.
    shared_ptr<js_ref_t> handle(
        PayloadHandler::allocate<BATCH_OUTPUT_TYPE_NAME>(env, id),
        [queue](js_ref_t* h) {
          BatchTokenOutput evt;
          evt.payloadHandle = h;
          evt.finished = true;
          queue->queueResult(any(std::move(evt)));
        });
    auto outputCallback = [handle = std::move(handle),
                           queue](const string& tokenOut) {
      BatchTokenOutput evt;
      evt.payloadHandle = handle.get();
      evt.output = tokenOut;
      queue->queueResult(any(std::move(evt)));
    };
    LlamaModel::Prompt prompt =
        parsePromptInputs(env, inputs, std::move(outputCallback));
    prompts.push_back(std::move(prompt));
  }

  return prompts;
}

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  // Worker-pool size for multi-job admission == the model's concurrency
  // (`parallel`/`n_seq_max`). Read straight from the config map before it is
  // moved into the model; absent means single-slot (1), a malformed or
  // out-of-range value throws before the model or scheduler is constructed.
  auto config = args.getSubmap(1, "config");
  // Bounded by K_MAX_PARALLEL_WORKERS (the engine's n_seq_max ceiling; see its
  // definition above). The pool is thread-per-slot and eager: `parallel` OS
  // threads are spawned at load and live for the model's lifetime, so a server
  // pays the whole cost upfront and is ready to serve at full concurrency with
  // no warm-up. The per-value cost below the ceiling is the user's documented
  // choice (see `parallel` in index.d.ts and docs/continuous-batching.md).
  unsigned maxConcurrency = 1;
  if (auto it = config.find("parallel"); it != config.end()) {
    try {
      maxConcurrency = parseUnsignedInRange(
          it->second, 1, K_MAX_PARALLEL_WORKERS, "parallel");
    } catch (const std::invalid_argument& e) {
      throw StatusError(general_error::InvalidArgument, e.what());
    }
  }

  unique_ptr<model::IModel> model = make_unique<LlamaModel>(
      args.getMapEntry(1, "path"),
      args.getMapEntry(1, "projectionPath"),
      std::move(config));

  // Always drive the model through the multi-job scheduler. With a 1-slot pool
  // it behaves like the single-job path (the model's process(input, id) falls
  // back to the single-job route when no batch scheduler is active), while
  // parallel >= 2 admits that many concurrent jobs. Raw model pointers stay
  // valid: AddonCpp owns the model for the scheduler's whole lifetime.
  // The default queueCapacity gives a nearly unbounded waiting room, so
  // rejectWhenBusy:false callers are queued, not rejected.
  auto scheduler = make_unique<MultiJobScheduler>(
      dynamic_cast<model::IModelMultiprocessor*>(model.get()),
      maxConcurrency,
      dynamic_cast<model::IModelCancel*>(model.get()),
      dynamic_cast<model::IModelCancelById*>(model.get()));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<out_handl::JsStringOutputHandler>());
  outHandlers.add(make_shared<out_handl::JsStringArrayOutputHandler>());
  outHandlers.add(make_shared<JsFinetuneProgressOutputHandler>());
  outHandlers.add(make_shared<JsFinetuneTerminalOutputHandler>());
  outHandlers.add(make_shared<JsBatchTokenOutputHandler>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(
      env, std::move(callback), std::move(model), std::move(scheduler));
  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto inputsArray = js::Array{env, args.get(1, "inputsArray")};

  // The scheduler mints the job id at admission and runJob returns it; the id
  // is handed back in the result — for a batch too, so several batch groups
  // can be in flight and each routes its terminal events (result, jobEnded
  // stats) to its own response.
  const bool isBatch = inputsArray.size(env) > 0 &&
                       inputsArray.get<js::Object>(env, 0)
                           .getOptionalProperty<js::Array>(env, "messages")
                           .has_value();
  if (isBatch) {
    // Reject before admission: otherwise processPromptBatchImpl throws the
    // same error on a scheduler worker, surfaced as an async rejection.
    if (!getLlamaModel(instance)->supportsBatching()) {
      throw StatusError(
          general_error::InvalidArgument,
          "Batch run() requires the model loaded with parallel >= 2 "
          "(continuous batching, n_seq_max > 1)");
    }
    // Local: several batch admissions may now overlap, each with its own ids.
    JsBatchIds batchIds;
    batchIds.reset(inputsArray.size(env));
    auto prompts = parseBatchInputs(env, instance, inputsArray, batchIds);
    const optional<JobId> jobId =
        instance.addonCpp->runJob(any(std::move(prompts)));

    js::Object result = js::Object::create(env);
    result.setProperty(
        env, "accepted", js::Boolean::create(env, jobId.has_value()));
    result.setProperty(env, "ids", batchIds.toJsArray(env));
    if (jobId.has_value()) {
      result.setProperty(
          env, "id", js::Number::create(env, static_cast<double>(*jobId)));
    }
    return result;
  }

  // Streamed tokens are tagged with the admission-minted id via the deferred
  // future: fulfilled right below, before any token can be produced.
  auto idPromise = make_shared<promise<JobId>>();
  vector<pair<string, js::Object>> inputs = parseInputArray(env, inputsArray);
  LlamaModel::Prompt prompt = parsePromptInputs(
      env,
      inputs,
      makeQueueCallback<string>(
          instance.addonCpp->outputQueue, idPromise->get_future().share()));

  const optional<JobId> jobId =
      instance.addonCpp->runJob(any(std::move(prompt)));
  idPromise->set_value(jobId.value_or(kNoJobId));

  js::Object result = js::Object::create(env);
  result.setProperty(
      env, "accepted", js::Boolean::create(env, jobId.has_value()));
  if (jobId.has_value()) {
    result.setProperty(
        env, "id", js::Number::create(env, static_cast<double>(*jobId)));
  }
  return result;
}
JSCATCH

// ── assessFit ────────────────────────────────────────────────────────────
//
// Projects one model against the memory free right now. Args: [request].
// Returns a Promise of the result.
//
// Takes no instance and loads nothing: the fitter reads GGUF metadata only.
// Resolves to "fits" or "does-not-fit" with the memory the load takes on each
// device, or "unknown" for a load the fitter cannot project. A model it cannot
// read, or an invalid request, rejects.
//
// The request is copied into plain C++ on the JS thread, the projection runs
// on a worker thread, and the result object is built back on the JS thread.

struct FitRequest {
  std::string modelPath;
  load_fit_normalization::ConfigMap config;
  std::optional<double> minCtxSize;
  std::optional<double> marginBytes;
};

struct FitDevice {
  std::string id;
  std::string name;
  bool unified;
  double usedBytes;
  double freeBytes;
  double totalBytes;
};

// The load as the fit resolved it: on "fits" the context and layer count the
// fitter settled on, on "does-not-fit" the ones the load asked for.
struct FitStats {
  double ctxSize;
  double gpuLayers;
};

struct FitResult {
  std::string status;
  std::vector<FitDevice> devices;
  std::optional<FitStats> stats;
};

inline FitResult unknownResult() { return FitResult{"unknown", {}, {}}; }

[[noreturn]] inline void throwFitError(
    qvac_errors::general_error::GeneralErrorCode code,
    const std::string& message) {
  throw qvac_errors::StatusError(code, "assessFit: " + message);
}

// The PCI bus ID when the backend reports one, so the same GPU matches across
// addons built on different backends; the device name otherwise.
//
// Unified marks memory the host owns: the CPU, an integrated GPU, a GPU that
// says it shares host memory, Android's OpenCL GPU, and a device that reports
// no memory of its own. A unified device that reports none takes the CPU's
// figures.
inline FitDevice fitDevice(
    ggml_backend_dev_t device, double usedBytes, double freeBytes,
    double totalBytes) {
  ggml_backend_dev_props props{};
  ggml_backend_dev_get_props(device, &props);
  const bool reportsNoMemory = totalBytes == 0;
#if defined(__ANDROID__)
  const char* registry =
      ggml_backend_reg_name(ggml_backend_dev_backend_reg(device));
  const bool androidOpenCl =
      registry != nullptr && std::strcmp(registry, "OpenCL") == 0;
#else
  const bool androidOpenCl = false;
#endif
  const bool unified = props.memory_unified ||
                       props.type == GGML_BACKEND_DEVICE_TYPE_IGPU ||
                       props.type == GGML_BACKEND_DEVICE_TYPE_CPU ||
                       androidOpenCl || reportsNoMemory;
  if (unified && reportsNoMemory) {
    if (ggml_backend_dev_t host =
            ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU)) {
      size_t hostFree = 0;
      size_t hostTotal = 0;
      ggml_backend_dev_memory(host, &hostFree, &hostTotal);
      freeBytes = static_cast<double>(hostFree);
      totalBytes = static_cast<double>(hostTotal);
    }
  }
  return {
      props.device_id != nullptr ? props.device_id : props.name,
      props.name,
      unified,
      usedBytes,
      freeBytes,
      totalBytes};
}

inline FitRequest parseFitRequest(js_env_t* env, js_callback_info_t* info) {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  auto request = args.getJsObject(0, "request");

  FitRequest parsed;
  parsed.modelPath =
      request.getProperty<js::String>(env, "modelPath").as<std::string>(env);

  auto number = [&](const char* name) -> std::optional<double> {
    auto value = request.getOptionalProperty<js::Number>(env, name);
    if (!value.has_value()) {
      return std::nullopt;
    }
    return value->as<double>(env);
  };

  // The config map `loadModel` takes, normalized below by the code that load
  // itself runs.
  if (auto config = request.getOptionalProperty<js::Object>(env, "config");
      config.has_value()) {
    js_value_t* names = nullptr;
    JS(js_get_property_names(env, *config, &names));
    auto keys = js::Array::fromValue(names);
    const size_t count = keys.size(env);
    for (size_t index = 0; index < count; ++index) {
      const std::string key =
          keys.get<js::String>(env, index).as<std::string>(env);
      parsed.config[key] = config->getProperty<js::String>(env, key.c_str())
                               .as<std::string>(env);
    }
  }

  parsed.minCtxSize = number("minCtxSize");
  parsed.marginBytes = number("marginBytes");
  return parsed;
}

// `common_fit_params` rewrites only the parameters it had to change, and
// restores every one of them on a status other than success. On
// `does-not-fit` the figures therefore describe the load as asked for, which
// is the demand that exceeded the machine.
//
// Runs on the worker thread. Setup, fitting and breakdown are serialised:
// fitting is not thread safe and temporarily swaps the global llama logger.
// The lock is taken by the worker, never while admitting a JS call.
inline FitResult runFit(FitRequest request) {
  static std::mutex fitMutex;
  const std::lock_guard<std::mutex> lock(fitMutex);
  const std::string& modelPath = request.modelPath;
  auto configFilemap = std::move(request.config);

  // `LlamaModel::init` takes both out of the map before normalizing.
  const auto takeConfig = [&configFilemap](const char* key) {
    std::string value;
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      value = it->second;
      configFilemap.erase(it);
    }
    return value;
  };
  const std::string backendsDir = takeConfig("backendsDir");
  const std::string openclCacheDir = takeConfig("openclCacheDir");

  // `common_fit_params` reads ggml's global device registry and loads nothing
  // itself, so whatever is registered here is its whole view of the machine.
  // The handle holds the reference count for the call: a model unloading on
  // another thread would otherwise free the backend underneath it.
  LlamaBackendsHandle backendsHandle(backendsDir, openclCacheDir);

  // An empty registry would still yield a verdict, measured against a machine
  // the fitter cannot see.
  if (ggml_backend_dev_count() == 0) {
    throwFitError(
        qvac_errors::general_error::InternalError,
        "no backend device is registered");
  }

  // A path llama cannot open reaches it as a `runtime_error` carrying no
  // filename, so the file is opened here first to name the cause.
  if (std::FILE* file = std::fopen(modelPath.c_str(), "rb")) {
    std::fclose(file);
  } else {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "cannot open the model file");
  }

  // The fitter measures device memory, and a cpu load's weights stay
  // file-backed, so it would project `fits` for nearly any model.
  if (auto device = configFilemap.find("device");
      device != configFilemap.end() && device->second == "cpu") {
    return unknownResult();
  }

  common_params loadParams;
  try {
    // Addon-only key, consumed before llama.cpp's parser sees it, as at load.
    const auto speculativeConfig =
        qvac_lib_inference_addon_llama::speculative::parseSpeculativeConfig(
            configFilemap);
    ModelMetaData metadata;
    metadata.parse(modelPath, GGUFShards{}, false, ADDON_ID);
    auto normalized = load_fit_normalization::normalizeLoadForFit(
        modelPath,
        std::move(configFilemap),
        metadata,
        {},
        load_fit_normalization::productionDependencies(
            LlamaModel::llamaLogCallback));
    loadParams = std::move(normalized.params);
    qvac_lib_inference_addon_llama::speculative::applySpeculativeConfig(
        speculativeConfig, loadParams);
  } catch (const std::exception& e) {
    throwFitError(qvac_errors::general_error::InvalidArgument, e.what());
  }
  // The draft model (DFlash or an MTP head) is a second file the fit reads;
  // probed like the target above. The load requires a regular file, and
  // `fopen` opens a directory on POSIX.
  if (const std::string& draftPath = loadParams.speculative.draft.mparams.path;
      !draftPath.empty()) {
    std::error_code error;
    std::FILE* file = std::filesystem::is_regular_file(draftPath, error)
                          ? std::fopen(draftPath.c_str(), "rb")
                          : nullptr;
    if (file == nullptr) {
      throwFitError(
          qvac_errors::general_error::InvalidArgument,
          "cannot open the draft model file");
    }
    std::fclose(file);
  }
  loadParams.embedding = false;

  // Each is a second resident file the projection does not count, so a load
  // carrying one would come back understated.
  if (!loadParams.lora_adapters.empty() || !loadParams.mmproj.path.empty()) {
    return unknownResult();
  }

  llama_model_params mparams = common_model_params_to_llama(loadParams);
  llama_context_params cparams = common_context_params_to_llama(loadParams);

  // `fit-ctx 0` stores `UINT32_MAX` in the signed field to mean "do not
  // reduce", so the round trip through unsigned restores the sentinel.
  const auto requestedMinCtx = request.minCtxSize;
  if (requestedMinCtx.has_value() &&
      (!std::isfinite(*requestedMinCtx) || *requestedMinCtx < 0)) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "minCtxSize must be a non-negative count");
  }
  const uint32_t minCtx =
      requestedMinCtx.has_value()
          ? static_cast<uint32_t>(*requestedMinCtx)
          : static_cast<uint32_t>(loadParams.fit_params_min_ctx);

  const auto requestedMargin = request.marginBytes;
  if (requestedMargin.has_value() &&
      (!std::isfinite(*requestedMargin) || *requestedMargin < 0)) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "marginBytes must be a non-negative byte count");
  }

  // In/out: the fitter rewrites only the entries still holding a llama
  // default, so a placement the load pinned survives into the projection.
  std::vector<float> tensorSplit(
      std::begin(loadParams.tensor_split),
      std::begin(loadParams.tensor_split) + llama_max_devices());
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  // llama walks this array to its `{nullptr, nullptr}` terminator, so a list
  // that does not fit with the terminator would be read past its end.
  if (loadParams.tensor_buft_overrides.size() > buftOverrides.size()) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "the load sets more tensor buffer overrides than llama accepts");
  }
  std::copy_n(
      loadParams.tensor_buft_overrides.begin(),
      loadParams.tensor_buft_overrides.size(),
      buftOverrides.begin());
  // `fit_params_target` already holds one entry per device, and `fit-target`
  // fills it, so it carries both llama's default and the load's own override.
  // A caller's margin answers a different question — what the models already
  // resident need — so the stricter of the two binds.
  std::vector<size_t> margins = loadParams.fit_params_target;
  if (requestedMargin.has_value()) {
    const auto requested = static_cast<size_t>(*requestedMargin);
    for (size_t& margin : margins) {
      margin = std::max(margin, requested);
    }
  }

  // Without the fitter the load places nothing, so there is no verdict.
  if (!loadParams.fit_params) {
    return unknownResult();
  }

  // A draft context (MTP, or a DFlash draft model) is fitted next to the
  // model, as the load does.
  const auto speculativeFit =
      qvac_lib_inference_addon_llama::speculative::SpeculativeFitModel::create(
          loadParams);

  // The load refuses an external MTP head for another model; so does the
  // projection, comparing the same header values.
  if (speculativeFit && speculativeFit->isMtp() &&
      !speculativeFit->extra()->shares_model) {
    namespace spec = qvac_lib_inference_addon_llama::speculative;
    const auto head = spec::readGgufShape(speculativeFit->extra()->path_model);
    const auto target = spec::readGgufShape(modelPath);
    const std::string mismatch = spec::mtpHeadMismatch(
        head.width, target.width, head.vocab, target.vocab);
    if (!mismatch.empty()) {
      throwFitError(qvac_errors::general_error::InvalidArgument, mismatch);
    }
  }

  common_params_fit_status status{};
  try {
    status = common_fit_params(
        modelPath.c_str(),
        &mparams,
        &cparams,
        tensorSplit.data(),
        buftOverrides.data(),
        margins.data(),
        minCtx,
        speculativeFit ? speculativeFit->extra() : nullptr,
        false,
        GGML_LOG_LEVEL_INFO,
        // The load's fit passes it too, so `moe-cache-mib: auto` sizes the
        // same expert cache in the projection as in the load.
        loadParams.moe_cache_auto_explicit);
  } catch (const std::exception& e) {
    // `common_fit_params` answers its own failures with a status, so a throw
    // escaping it came from the setup around the probe.
    throwFitError(qvac_errors::general_error::InternalError, e.what());
  }

  if (status == COMMON_PARAMS_FIT_STATUS_ERROR) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "the model cannot be read");
  }
  const char* statusName =
      status == COMMON_PARAMS_FIT_STATUS_SUCCESS ? "fits" : "does-not-fit";

  // The per-device breakdown is a second no-alloc probe, so it costs about
  // what the fit cost and only runs once a projection exists.
  std::vector<ggml_backend_dev_t> devices;
  uint32_t resolvedLayers = 0;
  uint32_t trainCtx = 0;
  uint32_t expertCount = 0;
  common_device_memory_data_vec breakdown;
  try {
    breakdown = common_get_device_memory_data(
        modelPath.c_str(),
        &mparams,
        &cparams,
        devices,
        resolvedLayers,
        trainCtx,
        expertCount,
        GGML_LOG_LEVEL_INFO);
  } catch (const std::exception&) {
    // A verdict is reported only with the rows it rests on.
    return unknownResult();
  }
  // The figures count the draft side, as the verdict does. A draft model the
  // fit cannot measure stays out of both, as fabric fits without it. An MTP
  // draft that cannot be measured, such as one without MTP layers, fails the
  // load, so it rejects. A failed fit leaves `n_ctx` 0, which the load
  // resolves to the trained context.
  llama_context_params draftCparams = cparams;
  draftCparams.n_ctx = cparams.n_ctx != 0 ? cparams.n_ctx : trainCtx;
  if (speculativeFit &&
      !speculativeFit->addMemory(
          modelPath.c_str(), mparams, draftCparams, devices, breakdown) &&
      speculativeFit->isMtp()) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "the MTP draft cannot be measured");
  }

  // A fitted context of 0 with no trained context names no usable load.
  if (cparams.n_ctx == 0 && trainCtx == 0) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "the model declares no trained context");
  }

  // The probe returns one row per device the model was assigned to, then a
  // trailing host row: the CPU device is counted among the devices but its
  // demand lands on the host. Weights mapped from the file under
  // LLAMA_LOAD_MODE_MMAP are page cache the OS can evict, so the host row
  // leaves them out, as fabric's own verdict does. A verdict always carries the
  // host row, so a probe without one, or a registry without a CPU device to
  // name it by, leaves the load unsized.
  ggml_backend_dev_t host =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (host == nullptr || breakdown.size() <= devices.size()) {
    return unknownResult();
  }
  const bool hostModelEvictable = mparams.load_mode == LLAMA_LOAD_MODE_MMAP;
  FitResult result;
  result.status = statusName;
  for (size_t i = 0; i < breakdown.size(); ++i) {
    const auto& row = breakdown[i];
    const bool hostRow = i >= devices.size();
    ggml_backend_dev_t device = hostRow ? host : devices[i];
    const double model =
        hostRow && hostModelEvictable ? 0 : static_cast<double>(row.model);
    // Device handles are borrowed from the backend, so only owned values leave
    // this worker for the result.
    result.devices.push_back(fitDevice(
        device,
        model + static_cast<double>(row.context) +
            static_cast<double>(row.compute),
        static_cast<double>(row.free),
        static_cast<double>(row.total)));
  }

  // A load that fits whole leaves llama's -1 in place. llama resolves that to
  // every layer plus the output layer, and to none when the placement holds no
  // device; the probe's device list never holds the CPU. `resolvedLayers`
  // omits an MTP model's nextn layers unless the load asked for them, so such a
  // model reports short of what llama would offload. A fitted context of 0 is
  // the trained context.
  const double gpuLayers =
      mparams.n_gpu_layers >= 0 ? static_cast<double>(mparams.n_gpu_layers)
      : devices.empty()         ? 0.0
                                : static_cast<double>(resolvedLayers) + 1;
  result.stats = FitStats{
      static_cast<double>(cparams.n_ctx != 0 ? cparams.n_ctx : trainCtx),
      gpuLayers};

#if defined(__APPLE__) && TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
  // The margin the fitter held back on each device is held back from the app's
  // limit too.
  const size_t margin =
      margins.empty() ? 0 : *std::max_element(margins.begin(), margins.end());
  result.status = qvac_lib_inference_addon_llama::applyAppMemoryBudget(
      result.status,
      result.devices,
      static_cast<double>(os_proc_available_memory()),
      static_cast<double>(margin));
#endif
  return result;
}

inline js_value_t* fitResultObject(js_env_t* env, const FitResult& fit) {
  auto result = js::Object::create(env);
  result.setProperty(env, "status", js::String::create(env, fit.status));
  auto devices = js::Array::create(env);
  for (size_t i = 0; i < fit.devices.size(); ++i) {
    const auto& row = fit.devices[i];
    auto entry = js::Object::create(env);
    entry.setProperty(env, "id", js::String::create(env, row.id));
    entry.setProperty(env, "name", js::String::create(env, row.name));
    entry.setProperty(env, "unified", js::Boolean::create(env, row.unified));
    entry.setProperty(env, "usedBytes", js::Number::create(env, row.usedBytes));
    entry.setProperty(env, "freeBytes", js::Number::create(env, row.freeBytes));
    entry.setProperty(
        env, "totalBytes", js::Number::create(env, row.totalBytes));
    devices.set(env, i, entry);
  }
  result.setProperty(env, "devices", devices);
  auto stats = js::Object::create(env);
  if (fit.stats.has_value()) {
    stats.setProperty(
        env, "ctxSize", js::Number::create(env, fit.stats->ctxSize));
    stats.setProperty(
        env, "gpuLayers", js::Number::create(env, fit.stats->gpuLayers));
  }
  result.setProperty(env, "stats", stats);
  return result;
}

inline js_value_t* assessFit(js_env_t* env, js_callback_info_t* info) try {
  FitRequest request = parseFitRequest(env, info);
  return js::JsAsyncTask::run(
      env,
      [request = std::move(request)]() mutable {
        return runFit(std::move(request));
      },
      fitResultObject);
}
JSCATCH

/// Requests occupying or waiting for a continuous-batching slot. Complements
/// JsInterface::activeJobs (a job count): one batch job of N prompts consumes
/// up to N slots, so only this number tracks the resource that runs out. 0
/// when no batch scheduler is active (`parallel: 1`), hence the JS admission
/// check takes the max of the two rather than replacing one with the other.
inline js_value_t* activeSlots(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  return js::Number::create(
      env, static_cast<double>(getLlamaModel(instance)->activeSlots()));
}
JSCATCH

inline js_value_t* cancel(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  const bool savePauseCheckpoint =
      args.getIntegralOptional<int>(1).value_or(1) != 0;

  // Capture by shared_ptr so the cancel work outlives a JS-side
  // destroyInstance(): the AddonCpp (and the LlamaModel it owns) must
  // stay alive until the async cancelJob() / pause-wait completes.
  // Previously we captured raw pointers (`auto* addonCpp = ... .get();`),
  // which let the test framework's teardown free the addon out from under
  // an in-flight cancel and trip a destroyed-mutex UAF inside the job
  // scheduler.
  auto addonCppRef = instance.addonCpp;
  // Snapshot the live job ids here, on the JS thread — where admissions also
  // run — so a job started after this call is never touched by the deferred
  // cancellation below.
  std::vector<qvac_lib_inference_addon_cpp::JobId> liveJobs =
      addonCppRef->liveJobIds();
  return js::JsAsyncTask::run(
      env,
      [addonCppRef, savePauseCheckpoint, liveJobs = std::move(liveJobs)]() {
        // A snapshotted finetune is cancelled through the same per-id path as
        // inference: cancelJobs -> cancelById lands on the job's bound
        // finetune cancel action, which consumes the checkpoint mode armed
        // here. Querying the finetuner directly ("whichever finetune is
        // running now") would break the snapshot above — a finetune admitted
        // after this cancel must never be paused by it.
        auto* llamaModel = tryGetLlamaModel(*addonCppRef);
        if (llamaModel != nullptr) {
          llamaModel->setFinetuneCancelSavesCheckpoint(
              savePauseCheckpoint, liveJobs);
        }
        // cancelJobs(snapshot), not cancelAllJobs(): the snapshot carries
        // the real tagged ids under the multi-job scheduler (cancelById
        // lands on each) and the untagged sentinel under the single-job
        // one, so "cancel the in-flight work" holds for both — while a job
        // admitted after the cancel request survives it. cancelJobs also
        // returns only after every snapshotted id has left the scheduler
        // (slot released — for a paused finetune that is after the
        // post-pause model reload), so a resolved cancel promise means an
        // immediate follow-up admission is not refused as busy.
        addonCppRef->cancelJobs(liveJobs);
        // The dispatch consumed the modes for whatever finetunes it reached;
        // entries left behind (inference ids, jobs that finished first) must
        // not outlive this cancel.
        if (llamaModel != nullptr) {
          llamaModel->discardFinetuneCancelSaveModes(liveJobs);
        }
      });
}
JSCATCH

/// Writes the conversation kept for a `cacheKey` to its file (see
/// LlamaModel::saveCache). Off the JS thread: it waits for a request running
/// on that key and for the batch worker to reach a step boundary.
inline js_value_t* saveCache(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  std::string cacheKey =
      js::String(env, args.get(1, "cacheKey")).as<std::string>(env);
  // Keeps the model alive past a JS-side destroyInstance(), as cancel does.
  auto addonCppRef = instance.addonCpp;
  return js::JsAsyncTask::run(
      env, [addonCppRef, cacheKey = std::move(cacheKey)]() {
        LlamaModel* model = tryGetLlamaModel(*addonCppRef);
        if (model == nullptr) {
          throw StatusError(
              general_error::InvalidArgument,
              "saveCache: the model is not loaded");
        }
        model->saveCache(cacheKey);
      });
}
JSCATCH

/// Drops the conversation kept for a `cacheKey` without writing it (see
/// LlamaModel::discardCache). Off the JS thread, like saveCache.
inline js_value_t* discardCache(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  std::string cacheKey =
      js::String(env, args.get(1, "cacheKey")).as<std::string>(env);
  auto addonCppRef = instance.addonCpp;
  return js::JsAsyncTask::run(
      env, [addonCppRef, cacheKey = std::move(cacheKey)]() {
        LlamaModel* model = tryGetLlamaModel(*addonCppRef);
        if (model == nullptr) {
          throw StatusError(
              general_error::InvalidArgument,
              "discardCache: the model is not loaded");
        }
        model->discardCache(cacheKey);
      });
}
JSCATCH

/// `calcTokens(instance, { text?, history?, tools? })`: tokens the input takes
/// on the loaded model (see LlamaModel::calcTokens, which lists what the count
/// leaves out). `history` and `tools` are JSON strings, like `runJob`'s
/// `input`. Resolves with the count as a plain number. An argument of the
/// wrong type throws synchronously; every other error rejects. Off the JS
/// thread: a reload holds the model's state lock.
inline js_value_t* calcTokens(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto params = args.getJsObject(1, "params");
  LlamaModel::CalcTokensRequest request;
  request.text =
      params.getOptionalPropertyAs<js::String, std::string>(env, "text");
  request.history =
      params.getOptionalPropertyAs<js::String, std::string>(env, "history");
  request.tools =
      params.getOptionalPropertyAs<js::String, std::string>(env, "tools");
  // Keeps the model alive past a JS-side destroyInstance(), as cancel does.
  auto addonCppRef = instance.addonCpp;
  return js::JsAsyncTask::run(
      env,
      [addonCppRef, request = std::move(request)]() {
        const LlamaModel* model = tryGetLlamaModel(*addonCppRef);
        if (model == nullptr) {
          throw StatusError(
              general_error::InvalidArgument,
              "calcTokens: the model is not loaded");
        }
        return model->calcTokens(request);
      },
      [](js_env_t* jsEnv, const size_t& count) -> js_value_t* {
        return js::Number::create(jsEnv, static_cast<double>(count));
      });
}
JSCATCH

inline js_value_t* finetune(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto paramsOpt = args.tryGetObject<LlamaFinetuningParams>(
      1, "finetuningParams", [](js_env_t* e, js::Object& jsObj) {
        return parseLlamaFinetuningParams(e, jsObj);
      });
  if (!paramsOpt.has_value()) {
    throw StatusError(
        general_error::InvalidArgument, "Finetuning parameters not provided");
  }

  // Tag finetune's streamed output and progress with the admission-minted id
  // via the deferred future (the same hand-off runJob uses); JS registers its
  // finetune sink under this id.
  auto idPromise = make_shared<promise<JobId>>();
  auto idFuture = idPromise->get_future().share();

  LlamaModel::Prompt prompt;
  prompt.finetuningParams = *paramsOpt;
  prompt.outputCallback =
      makeQueueCallback<string>(instance.addonCpp->outputQueue, idFuture);
  prompt.progressCallback =
      makeQueueCallback<llama_finetuning_helpers::FinetuneProgressStats>(
          instance.addonCpp->outputQueue, std::move(idFuture));

  // Finetune reloads weights, so it runs as an exclusive job — the scheduler
  // enforces the finetune<->inference mutual exclusion (see runExclusiveJob).
  const optional<JobId> jobId =
      instance.addonCpp->runExclusiveJob(any(std::move(prompt)));
  idPromise->set_value(jobId.value_or(kNoJobId));
  if (!jobId.has_value()) {
    // Refused (jobs queued or in flight): JS expects boolean false.
    return js::Boolean::create(env, false);
  }
  return js::Number::create(env, static_cast<double>(*jobId));
}
JSCATCH

} // namespace qvac_lib_inference_addon_llama
