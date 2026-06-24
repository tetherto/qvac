#pragma once
#include <any>
#include <cmath>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include <type_traits>
#include <vector>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "addon/JsBatchIds.hpp"
#include "addon/PayloadHandler.hpp"
#include "model-interface/LlamaFinetuningParams.hpp"
#include "model-interface/LlamaModel.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

/// JS event-name baked into batch payloads; must match `addon.js`
/// (`rawData.type === 'batch_output'`). Namespace-scope with linkage is
/// required to use it as a `const char*` template arg in `PayloadHandler`.
inline constexpr char kBatchOutputTypeName[] = "batch_output";

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

inline std::function<void(const std::string&)>
makeQueueOutputCallback(qvac_lib_inference_addon_cpp::AddonJs& instance) {
  return [&instance](const std::string& s) {
    instance.addonCpp->outputQueue->queueResult(std::any(s));
  };
}

inline LlamaFinetuner::ProgressCallback
makeQueueProgressCallback(qvac_lib_inference_addon_cpp::AddonJs& instance) {
  return [&instance](const llama_finetuning_helpers::FinetuneProgressStats& s) {
    instance.addonCpp->outputQueue->queueResult(std::any(s));
  };
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
  params.numberOfEpochs = static_cast<int>(
      jsObj.getOptionalPropertyAs<js::Number, int64_t>(env, "numberOfEpochs")
          .value_or(1));
  params.learningRate =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "learningRate")
          .value_or(1e-4);
  params.trainDatasetDir = jsObj.getProperty<js::String>(env, "trainDatasetDir")
                               .as<std::string>(env);
  const std::string evalDatasetPath =
      jsObj
          .getOptionalPropertyAs<js::String, std::string>(
              env, "evalDatasetPath")
          .value_or("");
  params.evalDatasetPath = evalDatasetPath;
  params.contextLength =
      jsObj.getOptionalPropertyAs<js::Number, int64_t>(env, "contextLength")
          .value_or(128);
  params.microBatchSize =
      jsObj.getOptionalPropertyAs<js::Number, int64_t>(env, "microBatchSize")
          .value_or(128);
  params.assistantLossOnly =
      jsObj.getOptionalPropertyAs<js::Boolean, bool>(env, "assistantLossOnly")
          .value_or(false);
  params.checkpointSaveDir =
      jsObj
          .getOptionalPropertyAs<js::String, std::string>(
              env, "checkpointSaveDir")
          .value_or("");
  params.loraModules =
      jsObj.getOptionalPropertyAs<js::String, std::string>(env, "loraModules")
          .value_or("");
  params.loraRank =
      jsObj.getOptionalPropertyAs<js::Number, int32_t>(env, "loraRank")
          .value_or(8);
  params.loraAlpha =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "loraAlpha")
          .value_or(16.0);
  params.loraInitStd =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "loraInitStd")
          .value_or(0.02);
  params.loraSeed = static_cast<uint32_t>(
      jsObj.getOptionalPropertyAs<js::Number, int64_t>(env, "loraSeed")
          .value_or(42));
  params.chatTemplatePath = jsObj
                                .getOptionalPropertyAs<js::String, std::string>(
                                    env, "chatTemplatePath")
                                .value_or("");
  params.checkpointSaveSteps = jsObj
                                   .getOptionalPropertyAs<js::Number, int64_t>(
                                       env, "checkpointSaveSteps")
                                   .value_or(0);
  params.lrMin = jsObj.getOptionalPropertyAs<js::Number, double>(env, "lrMin")
                     .value_or(0.0);
  params.lrScheduler =
      jsObj.getOptionalPropertyAs<js::String, std::string>(env, "lrScheduler")
          .value_or("cosine");
  params.warmupRatio =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "warmupRatio")
          .value_or(0.1);
  params.batchSize =
      jsObj.getOptionalPropertyAs<js::Number, int64_t>(env, "batchSize")
          .value_or(128);
  params.weightDecay =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "weightDecay")
          .value_or(0.01);
  params.warmupStepsSet =
      jsObj.getOptionalPropertyAs<js::Boolean, bool>(env, "warmupStepsSet")
          .value_or(false);
  params.warmupSteps =
      jsObj.getOptionalPropertyAs<js::Number, int64_t>(env, "warmupSteps")
          .value_or(0);
  params.warmupRatioSet =
      jsObj.getOptionalPropertyAs<js::Boolean, bool>(env, "warmupRatioSet")
          .value_or(false);
  params.validationSplit =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "validationSplit")
          .value_or(0.05);
  params.useEvalDatasetForValidation =
      jsObj
          .getOptionalPropertyAs<js::Boolean, bool>(
              env, "useEvalDatasetForValidation")
          .value_or(false);
  return params;
}

inline void parseGenerationParams(
    js_env_t* env, js::Object& inputObj, LlamaModel::Prompt& prompt) {
  using namespace qvac_lib_inference_addon_cpp;

  auto configObj =
      inputObj.getOptionalProperty<js::Object>(env, "generationParams");
  if (!configObj.has_value()) {
    return;
  }

  auto readNum = [&](const char* key, auto& out) {
    auto value = configObj->getOptionalPropertyAs<js::Number, double>(env, key);
    if (value.has_value()) {
      out =
          static_cast<typename std::decay_t<decltype(out)>::value_type>(*value);
    }
  };
  GenerationParams& overrides = prompt.generationParams;
  readNum("temp", overrides.temp);
  readNum("top_p", overrides.top_p);
  readNum("top_k", overrides.top_k);
  readNum("predict", overrides.n_predict);
  readNum("seed", overrides.seed);
  readNum("frequency_penalty", overrides.frequency_penalty);
  readNum("presence_penalty", overrides.presence_penalty);
  readNum("repeat_penalty", overrides.repeat_penalty);

  auto grammarStr =
      configObj->getOptionalPropertyAs<js::String, std::string>(env, "grammar");
  if (grammarStr.has_value() && !grammarStr->empty()) {
    overrides.grammar = std::move(*grammarStr);
  }

  auto jsonSchemaStr =
      configObj->getOptionalPropertyAs<js::String, std::string>(
          env, "json_schema");
  if (jsonSchemaStr.has_value() && !jsonSchemaStr->empty()) {
    overrides.json_schema = std::move(*jsonSchemaStr);
  }

  if (overrides.grammar && overrides.json_schema) {
    throw StatusError(
        general_error::InvalidArgument,
        "generationParams.grammar and generationParams.json_schema are "
        "mutually exclusive");
  }

  auto reasoningBudget = configObj->getOptionalPropertyAs<js::Number, double>(
      env, "reasoning_budget");
  if (reasoningBudget.has_value()) {
    // Reject fractional inputs (0.5, -1.1, 32.7) by requiring the value to
    // round-trip through int. -1 = unrestricted, 0 = disabled, N>0 caps the
    // reasoning channel at N tokens via the budget sampler.
    const double value = *reasoningBudget;
    if (value < -1 || value != std::floor(value) ||
        value > static_cast<double>(std::numeric_limits<int>::max())) {
      throw StatusError(
          general_error::InvalidArgument,
          "generationParams.reasoning_budget must be -1 (unrestricted), "
          "0 (disabled), or a positive integer (token cap)");
    }
    overrides.reasoning_budget = static_cast<int>(value);
  }

  auto removeThinkingFromContext =
      configObj->getOptionalPropertyAs<js::Boolean, bool>(
          env, "remove_thinking_from_context");
  if (removeThinkingFromContext.has_value()) {
    overrides.remove_thinking_from_context = *removeThinkingFromContext;
  }
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
        PayloadHandler::allocate<kBatchOutputTypeName>(env, id),
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

  unique_ptr<model::IModel> model = make_unique<LlamaModel>(
      args.getMapEntry(1, "path"),
      args.getMapEntry(1, "projectionPath"),
      args.getSubmap(1, "config"));

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

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));
  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto inputsArray = js::Array{env, args.get(1, "inputsArray")};
  const bool isBatch = inputsArray.size(env) > 0 &&
                       inputsArray.get<js::Object>(env, 0)
                           .getOptionalProperty<js::Array>(env, "messages")
                           .has_value();
  if (isBatch) {
    // Reject before admission: otherwise processPromptBatch throws the same
    // error on the worker thread, surfaced as an async rejection.
    if (!getLlamaModel(instance)->supportsBatching()) {
      throw StatusError(
          general_error::InvalidArgument,
          "Batch run() requires the model loaded with parallel >= 2 "
          "(continuous batching, text-only model with n_seq_max > 1)");
    }
    // Static to recycle vector capacity across calls; safe only while
    // admissions stay serialized (one batch in flight). Demote to a local
    // if that changes.
    static JsBatchIds batchIds;
    batchIds.reset(inputsArray.size(env));
    auto prompts = parseBatchInputs(env, instance, inputsArray, batchIds);
    js_value_t* acceptedJs = instance.runJob(any(std::move(prompts)));

    js::Object result = js::Object::create(env);
    result.setProperty(env, "accepted", acceptedJs);
    result.setProperty(env, "ids", batchIds.toJsArray(env));
    return result;
  }

  vector<pair<string, js::Object>> inputs = parseInputArray(env, inputsArray);
  LlamaModel::Prompt prompt =
      parsePromptInputs(env, inputs, makeQueueOutputCallback(instance));

  return instance.runJob(any(std::move(prompt)));
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
  // an in-flight cancel and trip a destroyed-mutex UAF in JobRunner.
  auto addonCppRef = instance.addonCpp;
  return js::JsAsyncTask::run(env, [addonCppRef, savePauseCheckpoint]() {
    auto* llamaModel = tryGetLlamaModel(*addonCppRef);
    if (llamaModel && llamaModel->finetuner().isFinetuneRunning() &&
        llamaModel->finetuner().requestPause(savePauseCheckpoint)) {
      llamaModel->finetuner().waitUntilFinetuningPauseComplete();
    } else {
      addonCppRef->cancelJob();
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

  LlamaModel::Prompt prompt;
  prompt.finetuningParams = *paramsOpt;
  prompt.outputCallback = makeQueueOutputCallback(instance);
  prompt.progressCallback = makeQueueProgressCallback(instance);

  return instance.runJob(any(std::move(prompt)));
}
JSCATCH

} // namespace qvac_lib_inference_addon_llama
