#pragma once
#include <algorithm>
#include <any>
#include <functional>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <vector>

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
    prompt.saveCacheToDisk =
        inputObj
            .getOptionalPropertyAs<js::Boolean, bool>(env, "saveCacheToDisk")
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
