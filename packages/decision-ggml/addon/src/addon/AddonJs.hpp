#pragma once
#include <any>
#include <memory>
#include <string>
#include <utility>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/job/MultiJobScheduler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "addon/DecisionEngineScheduler.hpp"
#include "model-interface/DecisionEngineModel.hpp"
#include "model-interface/LayaModel.hpp"

namespace qvac_lib_inference_addon_decision {

/// Creates the JS instance of a @p ModelT whose outputs @p OutputHandlerT
/// delivers. Args: [jsHandle, { path, config, backendsDir }, outputCallback].
template <typename ModelT, typename OutputHandlerT>
js_value_t* createModelInstance(js_env_t* env, js_callback_info_t* info) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  auto model = make_unique<ModelT>(
      args.getMapEntry(1, "path"),
      args.getSubmap(1, "config"),
      args.getMapEntry(1, "backendsDir"));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<OutputHandlerT>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}

/// Delivers laya's response JSON as a JS string; the JS side parses it.
struct JsLayaDecisionOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          LayaDecisionResult> {
  JsLayaDecisionOutputHandler()
      : JsBaseOutputHandler<LayaDecisionResult>(
            [this](const LayaDecisionResult& out) -> js_value_t* {
              return qvac_lib_inference_addon_cpp::js::String::create(
                  this->env_, out.json);
            }) {}
};

inline js_value_t*
createLayaInstance(js_env_t* env, js_callback_info_t* info) try {
  return createModelInstance<LayaModel, JsLayaDecisionOutputHandler>(env, info);
}
JSCATCH

/// Delivers an upstream decision response JSON as a JS string; the JS side
/// parses it.
struct JsDecisionEngineOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          DecisionEngineResult> {
  JsDecisionEngineOutputHandler()
      : JsBaseOutputHandler<DecisionEngineResult>(
            [this](const DecisionEngineResult& out) -> js_value_t* {
              return qvac_lib_inference_addon_cpp::js::String::create(
                  this->env_, out.json);
            }) {}
};

/// Like createModelInstance, but drives the model through a one-slot
/// MultiJobScheduler: jobs carry ids, the model registers each job in its
/// JobCancelRegistry in jobStarting() under the scheduler's admission lock,
/// and a cancel that lands before process() starts is held there instead of
/// being lost. Args: [jsHandle, { path, config, backendsDir },
/// outputCallback].
inline js_value_t*
createDecisionEngineInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  auto model = make_unique<DecisionEngineModel>(
      args.getMapEntry(1, "path"),
      args.getSubmap(1, "config"),
      args.getMapEntry(1, "backendsDir"));

  // One request at a time, rejected while busy (see
  // makeDecisionEngineScheduler). Raw model pointers stay valid: AddonCpp owns
  // the model for the scheduler's lifetime.
  auto scheduler = makeDecisionEngineScheduler(*model);

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<JsDecisionEngineOutputHandler>());
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

/// Args: [instance]. Returns the loaded model's decision capabilities as a
/// JSON string (see DecisionContext::info). Blocks until the load ends, so
/// call it after activate().
inline js_value_t* decisionInfo(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  JsArgsParser args(env, info);
  auto& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto* engine =
      dynamic_cast<DecisionEngineModel*>(&instance.addonCpp->model.get());
  if (engine == nullptr) {
    throw StatusError(
        general_error::InvalidArgument,
        "decisionInfo: the instance is not a DecisionEngine");
  }
  return js::String::create(env, engine->info());
}
JSCATCH

/// Args: [instance, { type: "text", input }]. Both engines take one request
/// JSON string per job.
inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  auto [type, jsInput] = JsInterface::getInput(args);
  if (type != "text") {
    throw StatusError(
        general_error::InvalidArgument, "Unknown input type: " + type);
  }
  std::any input = js::String(env, jsInput).as<std::string>(env);
  return JsInterface::getInstance(env, args.get(0, "instance"))
      .runJob(std::move(input));
}
JSCATCH

} // namespace qvac_lib_inference_addon_decision
