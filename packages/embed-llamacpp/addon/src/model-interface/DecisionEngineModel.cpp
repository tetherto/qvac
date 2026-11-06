#include "DecisionEngineModel.hpp"

#include <chrono>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <nlohmann/json.hpp>

#include "addon/BertErrors.hpp"
#include "utils.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;

namespace {

using json = nlohmann::ordered_json;

const std::unordered_set<std::string>& allowedConfigKeys() {
  static const std::unordered_set<std::string> keys = {
      "device",
      "gpu_layers",
      "gpu-layers",
      "ctx_size",
      "ctx-size",
      "batch_size",
      "batch-size",
      "ubatch_size",
      "ubatch-size",
      "threads",
      "parallel",
      "mmproj",
      "verbosity",
      "openclCacheDir"};
  return keys;
}

std::string firstOf(
    const std::unordered_map<std::string, std::string>& config,
    std::initializer_list<const char*> names) {
  for (const char* name : names) {
    if (auto it = config.find(name); it != config.end()) {
      return it->second;
    }
  }
  return {};
}

int toInt(const std::string& key, const std::string& value) {
  try {
    size_t used = 0;
    const int n = std::stoi(value, &used);
    if (used != value.size()) {
      throw std::invalid_argument(value);
    }
    return n;
  } catch (const std::exception&) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format(
            "%s must be an integer, got '%s'", key.c_str(), value.c_str()));
  }
}

// Takes ownership of a bridge string.
std::string takeString(char* s) {
  std::string out = s != nullptr ? s : "";
  qvac_fabric_decision_free_string(s);
  return out;
}

// The message of a bridge {"error": {...}} payload, or the payload itself.
std::string errorMessage(const std::string& payload) {
  try {
    const json j = json::parse(payload);
    if (j.contains("error") && j["error"].contains("message")) {
      return j["error"]["message"].get<std::string>();
    }
  } catch (const std::exception&) {
  }
  return payload;
}

} // namespace

std::string DecisionEngineModel::paramsJson(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config) {
  checkLoadOptions(
      config,
      allowedConfigKeys(),
      __func__,
      "DecisionEngine",
      "device, gpu_layers, ctx_size, batch_size, ubatch_size, threads, "
      "parallel, mmproj, verbosity, openclCacheDir");

  json p = json::object();
  p["model"] = modelGgufPath;

  const std::string device = firstOf(config, {"device"});
  if (device.empty()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        "device is required ('gpu' or 'cpu')");
  }
  if (device != "gpu" && device != "cpu") {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format(
            "device must be 'gpu' or 'cpu', got '%s'", device.c_str()));
  }
  if (device == "cpu") {
    p["n_gpu_layers"] = 0;
  } else if (
      const std::string v = firstOf(config, {"gpu_layers", "gpu-layers"});
      !v.empty()) {
    p["n_gpu_layers"] = toInt("gpu_layers", v);
  }
  if (const std::string v = firstOf(config, {"ctx_size", "ctx-size"});
      !v.empty()) {
    p["n_ctx"] = toInt("ctx_size", v);
  }
  if (const std::string v = firstOf(config, {"batch_size", "batch-size"});
      !v.empty()) {
    p["n_batch"] = toInt("batch_size", v);
  }
  if (const std::string v = firstOf(config, {"ubatch_size", "ubatch-size"});
      !v.empty()) {
    p["n_ubatch"] = toInt("ubatch_size", v);
  }
  if (const std::string v = firstOf(config, {"threads"}); !v.empty()) {
    p["n_threads"] = toInt("threads", v);
  }
  if (const std::string v = firstOf(config, {"parallel"}); !v.empty()) {
    const int n = toInt("parallel", v);
    if (n < 1) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(InvalidConfiguration),
          "parallel must be at least 1");
    }
    p["n_parallel"] = n;
  }
  if (const std::string v = firstOf(config, {"mmproj"}); !v.empty()) {
    p["mmproj"] = v;
  }
  return p.dump();
}

DecisionEngineModel::DecisionEngineModel(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& /*backendsDir*/) {
  // Validate the options now, so a bad key fails at creation like LayaModel;
  // the model itself loads on activate().
  std::string params = paramsJson(modelGgufPath, config);
  initLoader_.init(
      InitLoader::LOADER_TYPE::DELAYED,
      [this](std::string p) { load(p); },
      std::move(params));
}

DecisionEngineModel::~DecisionEngineModel() {
  // Cancels a run still in flight and joins the engine's loop thread.
  qvac_fabric_decision_destroy(engine_);
  engine_ = nullptr;
}

void DecisionEngineModel::load(const std::string& paramsJson) {
  char* error = nullptr;
  qvac_fabric_decision* engine = nullptr;
  const int status =
      qvac_fabric_decision_create(paramsJson.c_str(), &engine, &error);
  const std::string message = errorMessage(takeString(error));
  if (status == QVAC_FABRIC_DECISION_INVALID_REQUEST) {
    // Bad params, or a model without upstream decision metadata.
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedModel),
        string_format("%s: %s", __func__, message.c_str()));
  }
  if (status != QVAC_FABRIC_DECISION_OK || engine == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadModel),
        string_format("%s: %s", __func__, message.c_str()));
  }
  engine_ = engine;
  info_ = takeString(qvac_fabric_decision_info(engine_));
}

std::string DecisionEngineModel::info() {
  initLoader_.waitForLoadInitialization();
  return info_;
}

std::any DecisionEngineModel::process(const std::any& input) {
  if (input.type() != typeid(std::string)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "DecisionEngineModel::process: the input must be the request JSON "
        "string");
  }
  return predict(std::any_cast<const std::string&>(input));
}

DecisionEngineResult
DecisionEngineModel::predict(const std::string& requestJson) {
  initLoader_.waitForLoadInitialization();

  qvac_fabric_decision_cancel* token = qvac_fabric_decision_cancel_create();
  {
    std::lock_guard<std::mutex> lock(cancelMutex_);
    running_ = token;
  }

  const auto start = std::chrono::steady_clock::now();
  char* out = nullptr;
  const int status =
      qvac_fabric_decision_run(engine_, requestJson.c_str(), token, &out);
  const std::string body = takeString(out);
  lastMs_ = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - start)
                .count();

  {
    std::lock_guard<std::mutex> lock(cancelMutex_);
    running_ = nullptr;
  }
  qvac_fabric_decision_cancel_release(token);

  switch (status) {
  case QVAC_FABRIC_DECISION_OK:
    break;
  case QVAC_FABRIC_DECISION_CANCELLED:
    // The job scheduler reports this as a cancellation, as with LayaModel.
    throw std::runtime_error("Job cancelled");
  case QVAC_FABRIC_DECISION_INVALID_REQUEST:
    // Job errors reach JS as their message only, so "invalid request: " is a
    // stable marker: decision.ts turns it into err.code
    // DECISION_INVALID_REQUEST for callers that map it (e.g. to HTTP 400).
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidRequest),
        string_format(
            "%s: invalid request: %s", __func__, errorMessage(body).c_str()));
  default:
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(DecodeFailed),
        string_format("%s: %s", __func__, errorMessage(body).c_str()));
  }

  lastInputTokens_ = 0;
  try {
    const json result = json::parse(body);
    lastInputTokens_ = result.value("/usage/input_tokens"_json_pointer, 0LL);
  } catch (const std::exception&) {
  }
  return DecisionEngineResult{body};
}

qvac_lib_inference_addon_cpp::RuntimeStats
DecisionEngineModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  if (engine_ == nullptr) {
    return stats;
  }
  // decision_input_tokens also lets the JS side recognize these stats.
  stats.emplace_back("decision_input_tokens", lastInputTokens_);
  stats.emplace_back("total_time_ms", lastMs_);
  return stats;
}

void DecisionEngineModel::cancel() const {
  std::lock_guard<std::mutex> lock(cancelMutex_);
  qvac_fabric_decision_cancel_request(running_);
}

void DecisionEngineModel::setWeightsForFile(
    const std::string& /*filename*/,
    std::unique_ptr<std::basic_streambuf<char>>&& /*shard*/) {
  throw qvac_errors::StatusError(
      ADDON_ID,
      toString(InvalidConfiguration),
      "DecisionEngine loads from a file path; weight streaming is not "
      "supported");
}
