#include "DecisionEngineModel.hpp"

#include <chrono>
#include <limits>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>
#include <nlohmann/json.hpp>

#include "addon/DecisionErrors.hpp"
#include "logging.hpp"
#include "utils.hpp"

using namespace qvac_lib_inference_addon_decision::errors;
using qvac_lib_inference_addon_decision::DecisionContext;

namespace {

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

[[noreturn]] void invalidConfig(const std::string& message) {
  throw qvac_errors::StatusError(
      ADDON_ID, toString(InvalidConfiguration), message);
}

/// The integer value of option @p key, at least @p min.
int toInt(const std::string& key, const std::string& value, int min) {
  int n = 0;
  try {
    size_t used = 0;
    n = std::stoi(value, &used);
    if (used != value.size()) {
      throw std::invalid_argument(value);
    }
  } catch (const std::exception&) {
    invalidConfig(string_format(
        "%s must be an integer, got '%s'", key.c_str(), value.c_str()));
  }
  if (n < min) {
    invalidConfig(string_format("%s must be at least %d", key.c_str(), min));
  }
  return n;
}

const std::string& requestOf(const std::any& input) {
  if (input.type() != typeid(std::string)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "DecisionEngineModel::process: the input must be the request JSON "
        "string");
  }
  return std::any_cast<const std::string&>(input);
}

} // namespace

common_params DecisionEngineModel::loadParams(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config) {
  checkLoadOptions(
      config,
      allowedConfigKeys(),
      __func__,
      "DecisionEngine",
      "device, gpu_layers, ctx_size, batch_size, ubatch_size, threads, "
      "parallel, mmproj, verbosity, openclCacheDir");

  common_params params;
  params.model.path = modelGgufPath;
  // Idle sleep stays off: the addon's load/unload lifecycle owns the model.
  params.sleep_idle_seconds = -1;

  const std::string device = firstOf(config, {"device"});
  if (device.empty()) {
    invalidConfig("device is required ('gpu' or 'cpu')");
  }
  if (device != "gpu" && device != "cpu") {
    invalidConfig(string_format(
        "device must be 'gpu' or 'cpu', got '%s'", device.c_str()));
  }
  if (device == "cpu") {
    // CPU means CPU for the projector too: upstream defaults mmproj_use_gpu
    // to true, which would run media encoding on the GPU.
    params.n_gpu_layers = 0;
    params.mmproj_use_gpu = false;
  } else if (
      const std::string v = firstOf(config, {"gpu_layers", "gpu-layers"});
      !v.empty()) {
    params.n_gpu_layers = toInt("gpu_layers", v, -1);
  }
  // 0 is the model's own context size.
  if (const std::string v = firstOf(config, {"ctx_size", "ctx-size"});
      !v.empty()) {
    params.n_ctx = toInt("ctx_size", v, 0);
  }
  // A batch of 0 cannot hold a token.
  if (const std::string v = firstOf(config, {"batch_size", "batch-size"});
      !v.empty()) {
    params.n_batch = toInt("batch_size", v, 1);
  }
  if (const std::string v = firstOf(config, {"ubatch_size", "ubatch-size"});
      !v.empty()) {
    params.n_ubatch = toInt("ubatch_size", v, 1);
  }
  // 0 or below leaves upstream's default, every CPU (checkLoadOptions has
  // already checked the value).
  if (const std::string v = firstOf(config, {"threads"}); !v.empty()) {
    if (const int n = toInt("threads", v, std::numeric_limits<int>::min());
        n > 0) {
      params.cpuparams.n_threads = n;
    }
  }
  // Upstream creates one execution slot per n_parallel and does not check it:
  // with 0 slots every request would stay deferred forever.
  if (const std::string v = firstOf(config, {"parallel"}); !v.empty()) {
    params.n_parallel = toInt("parallel", v, 1);
  }
  if (const std::string v = firstOf(config, {"mmproj"}); !v.empty()) {
    params.mmproj.path = v;
  }
  return params;
}

DecisionEngineModel::DecisionEngineModel(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& backendsDir)
    : backendsDir_(backendsDir),
      openclCacheDir_(firstOf(config, {"openclCacheDir"})) {
  // Validate the options now, so a bad key fails at creation; the model
  // itself loads on activate().
  common_params params = loadParams(modelGgufPath, config);
  // Before the backends register the log callback that reads it.
  std::unordered_map<std::string, std::string> logConfig = config;
  qvac_lib_inference_addon_decision::logging::setVerbosityLevel(logConfig);
  initLoader_.init(
      InitLoader::LOADER_TYPE::DELAYED,
      [this](const common_params& loaded) { load(loaded); },
      std::move(params));
}

DecisionEngineModel::~DecisionEngineModel() {
  // Stops a run still in flight and joins the context's loop thread; the
  // backends handle is released afterwards, with the members.
  context_.reset();
}

void DecisionEngineModel::load(const common_params& params) {
  // The addon's shared backend initializer: loads the backends once, routes
  // llama logs to the addon logger and, on Android, points the OpenCL kernel
  // cache at openclCacheDir. It must run before the context is created.
  backends_.emplace(backendsDir_, openclCacheDir_);
  context_ = std::make_unique<DecisionContext>(params);
  info_ = context_->info();
}

std::string DecisionEngineModel::info() {
  initLoader_.waitForLoadInitialization();
  return info_;
}

std::any DecisionEngineModel::process(const std::any& input) {
  return process(input, qvac_lib_inference_addon_cpp::kNoJobId);
}

std::any DecisionEngineModel::process(const std::any& input, JobId id) {
  // The job leaves the registry on every path; a later cancel(id) is a no-op.
  struct Finish {
    JobCancelRegistry& jobs;
    JobId id;
    Finish(JobCancelRegistry& jobs, JobId id) : jobs(jobs), id(id) {}
    Finish(const Finish&) = delete;
    Finish& operator=(const Finish&) = delete;
    ~Finish() { jobs.remove(id); }
  } finish(liveJobs_, id);
  return run(requestOf(input), id);
}

void DecisionEngineModel::jobStarting(JobId id) { liveJobs_.add(id); }

void DecisionEngineModel::cancelById(JobId id) const { liveJobs_.cancel(id); }

void DecisionEngineModel::cancel() const {
  // Unarmed jobs are parked and cancel when they arm; armed runs see the new
  // epoch at their next stop check.
  liveJobs_.parkAll();
  cancelEpoch_.fetch_add(1, std::memory_order_acq_rel);
}

DecisionEngineResult
DecisionEngineModel::run(const std::string& requestJson, JobId id) {
  // The epoch is read before the job arms: a whole-model cancel either parks
  // the job before it arms or bumps the epoch after this read.
  const std::uint64_t epoch = cancelEpoch_.load(std::memory_order_acquire);
  auto stopped = std::make_shared<std::atomic<bool>>(false);
  if (liveJobs_.add(id, [stopped]() {
        stopped->store(true, std::memory_order_release);
      })) {
    // Cancelled between jobStarting() and now: end without loading or running.
    throw std::runtime_error("Job cancelled");
  }
  const auto shouldStop = [this, stopped, epoch]() {
    return stopped->load(std::memory_order_acquire) ||
           cancelEpoch_.load(std::memory_order_acquire) != epoch;
  };
  if (shouldStop()) {
    throw std::runtime_error("Job cancelled");
  }
  initLoader_.waitForLoadInitialization();

  const auto start = std::chrono::steady_clock::now();
  std::string body = context_->run(requestJson, shouldStop);
  lastMs_ = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - start)
                .count();

  lastInputTokens_ = 0;
  try {
    const auto result = nlohmann::json::parse(body);
    lastInputTokens_ = result.value("/usage/input_tokens"_json_pointer, 0LL);
  } catch (const std::exception&) {
  }
  return DecisionEngineResult{std::move(body)};
}

qvac_lib_inference_addon_cpp::RuntimeStats
DecisionEngineModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  if (!context_) {
    return stats;
  }
  // decision_input_tokens also lets the JS side recognize these stats.
  stats.emplace_back("decision_input_tokens", lastInputTokens_);
  stats.emplace_back("total_time_ms", lastMs_);
  return stats;
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
