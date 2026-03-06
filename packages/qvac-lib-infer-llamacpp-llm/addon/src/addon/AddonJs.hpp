#pragma once
#include <chrono>
#include <functional>
#include <memory>
#include <sstream>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "model-interface/LlamaFinetuningParams.hpp"
#include "model-interface/LlamaModel.hpp"
#include "utils/LoggingMacros.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

inline LlamaModel*
getLlamaModel(qvac_lib_inference_addon_cpp::AddonJs& instance) {
  return static_cast<LlamaModel*>(&instance.addonCpp->model.get());
}

inline std::function<void(const std::string&)>
makeQueueOutputCallback(qvac_lib_inference_addon_cpp::AddonJs& instance) {
  return [&instance](const std::string& s) {
    instance.addonCpp->outputQueue->queueResult(std::any(s));
  };
}

inline LlamaModel::ProgressCallback
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
                  "loss",
                  js::Number::create(this->env_, stats.loss));
              statsObj.setProperty(
                  this->env_,
                  "accuracy",
                  js::Number::create(this->env_, stats.accuracy));
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
                    "val_loss",
                    js::Number::create(this->env_, result.stats->valLoss));
                statsObj.setProperty(
                    this->env_,
                    "train_accuracy",
                    js::Number::create(
                        this->env_, result.stats->trainAccuracy));
                statsObj.setProperty(
                    this->env_,
                    "val_accuracy",
                    js::Number::create(this->env_, result.stats->valAccuracy));
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

inline LlamaFinetuningParams
parseLlamaFinetuningParams(js_env_t* env, js::Object& jsObj) {
  LlamaFinetuningParams params;
  params.outputParametersDir =
      jsObj.getProperty<js::String>(env, "outputParametersDir")
          .as<std::string>(env);
  params.numberOfEpochs = static_cast<int>(
      jsObj.getProperty<js::Uint32>(env, "numberOfEpochs").as<uint32_t>(env));
  params.learningRate =
      jsObj.getProperty<js::Number>(env, "learningRate").as<double>(env);
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
          .value_or(0);
  params.microBatchSize =
      jsObj.getOptionalPropertyAs<js::Number, int64_t>(env, "microBatchSize")
          .value_or(0);
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
  params.loraDropout =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "loraDropout")
          .value_or(0.0);
  params.loraInitStd =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "loraInitStd")
          .value_or(0.01);
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
          .value_or("constant");
  params.warmupRatio =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "warmupRatio")
          .value_or(0.0);
  params.batchSize =
      jsObj.getOptionalPropertyAs<js::Number, int64_t>(env, "batchSize")
          .value_or(0);
  params.weightDecay =
      jsObj.getOptionalPropertyAs<js::Number, double>(env, "weightDecay")
          .value_or(0.0);
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
  outHandlers.add(make_shared<JsFinetuneProgressOutputHandler>());
  outHandlers.add(make_shared<JsFinetuneTerminalOutputHandler>());
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
  vector<pair<string, js::Object>> inputs = JsInterface::getInputsArray(args);

  LlamaModel::Prompt prompt;
  prompt.outputCallback = [&](const string& tokenOut) {
    instance.addonCpp->outputQueue->queueResult(any(tokenOut));
  };

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

  return instance.runJob(any(std::move(prompt)));
}
JSCATCH

inline js_value_t* cancel(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  LlamaModel* llamaModel = getLlamaModel(instance);
  auto* addonCpp = instance.addonCpp.get();

  return js::JsAsyncTask::run(env, [llamaModel, addonCpp]() {
    const auto cancelStart = std::chrono::steady_clock::now();
    if (llamaModel == nullptr) {
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "[PauseDebug][attempt=0] AddonJs::cancel: llamaModel=null fallback "
          "cancelJob");
      addonCpp->cancelJob();
      return;
    }

    const bool finetuneRunning = llamaModel->isFinetuneRunning();
    bool didRequestPause = false;
    uint64_t attemptId = llamaModel->getCurrentPauseAttemptIdForDebug();
    if (finetuneRunning) {
      didRequestPause = llamaModel->requestPause();
      attemptId = llamaModel->getCurrentPauseAttemptIdForDebug();
    }

    std::ostringstream decisionMsg;
    decisionMsg << "[PauseDebug][attempt=" << attemptId
                << "] AddonJs::cancel: branch-decision"
                << " isFinetuneRunning=" << (finetuneRunning ? "true" : "false")
                << " requestPause=" << (didRequestPause ? "true" : "false")
                << " path="
                << ((finetuneRunning && didRequestPause)
                        ? "WAIT_FOR_PAUSE_DONE"
                        : "CANCEL_JOB_FALLBACK");
    QLOG_IF(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        decisionMsg.str());

    if (finetuneRunning && didRequestPause) {
      const auto waitStart = std::chrono::steady_clock::now();
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "[PauseDebug][attempt=" + std::to_string(attemptId) +
              "] AddonJs::cancel: entering waitUntilFinetuningPauseComplete");
      llamaModel->waitUntilFinetuningPauseComplete();
      const auto waitElapsedMs =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - waitStart)
              .count();
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "[PauseDebug][attempt=" + std::to_string(attemptId) +
              "] AddonJs::cancel: waitUntilFinetuningPauseComplete returned"
              " elapsedMs=" +
              std::to_string(waitElapsedMs));
    } else {
      const auto fallbackStart = std::chrono::steady_clock::now();
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "[PauseDebug][attempt=" + std::to_string(attemptId) +
              "] AddonJs::cancel: entering addonCpp->cancelJob fallback");
      addonCpp->cancelJob();
      const auto fallbackElapsedMs =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - fallbackStart)
              .count();
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "[PauseDebug][attempt=" + std::to_string(attemptId) +
              "] AddonJs::cancel: addonCpp->cancelJob fallback returned"
              " elapsedMs=" +
              std::to_string(fallbackElapsedMs));
    }

    const auto totalElapsedMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - cancelStart)
            .count();
    QLOG_IF(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[PauseDebug][attempt=" + std::to_string(attemptId) +
            "] AddonJs::cancel: completed elapsedMs=" +
            std::to_string(totalElapsedMs));
  });
}
JSCATCH

inline js_value_t* finetune(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;
  const auto start = std::chrono::steady_clock::now();

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  QLOG_IF(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[ResumeTrace][bridge] AddonJs::finetune enter");

  LlamaModel* llamaModel = getLlamaModel(instance);
  if (llamaModel == nullptr) {
    throw StatusError(
        general_error::InvalidArgument,
        "Model not available or not a LlamaModel");
  }

  auto paramsOpt = args.tryGetObject<LlamaFinetuningParams>(
      1, "finetuningParams", [](js_env_t* e, js::Object& jsObj) {
        return parseLlamaFinetuningParams(e, jsObj);
      });
  QLOG_IF(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[ResumeTrace][bridge] AddonJs::finetune params-parsed hasParams=" +
          std::string(paramsOpt.has_value() ? "true" : "false"));
  if (!paramsOpt.has_value()) {
    throw StatusError(
        general_error::InvalidArgument, "Finetuning parameters not provided");
  }

  LlamaModel::Prompt prompt;
  prompt.finetuningParams = *paramsOpt;
  prompt.outputCallback = makeQueueOutputCallback(instance);
  prompt.progressCallback = makeQueueProgressCallback(instance);
  QLOG_IF(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[ResumeTrace][bridge] AddonJs::finetune before-runJob");
  const bool accepted = instance.addonCpp->runJob(any(std::move(prompt)));
  const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() - start)
                             .count();
  QLOG_IF(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[ResumeTrace][bridge] AddonJs::finetune after-runJob accepted=" +
          std::string(accepted ? "true" : "false") +
          " elapsedMs=" + std::to_string(elapsedMs));
  return js::Boolean::create(env, accepted);
}
JSCATCH

} // namespace qvac_lib_inference_addon_llama
