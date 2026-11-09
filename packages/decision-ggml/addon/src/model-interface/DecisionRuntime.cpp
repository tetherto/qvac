// Upstream llama.cpp's decision execution (tools/server server-context), run
// in-process. Upstream keeps decision parsing, prompt rendering, task
// scheduling and answer calculation; this file only owns the engine lifecycle,
// cancellation, the request depth guard and the mapping of outcomes to
// explicit statuses. No HTTP server is created: post_systemone is called
// directly with a request struct.
//
// server-context is linked statically into this addon (from @qvac/fabric's
// platform package); its llama / common / mtmd references resolve from the
// shared fabric runtime.

#include "DecisionRuntime.hpp"

#include <condition_variable>
#include <exception>
#include <filesystem>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

#include <common.h>
#include <json.h>
#include <llama.h>
#include <qvac-fabric.h>
#include <server-context.h>
#include <server-decision.h>
#include <server-http.h>

namespace qvac_lib_infer_llamacpp_decision {

struct DecisionRuntime::State {
  // Declaration order is destruction order in reverse: routes refers to ctx
  // and to params, so it must go first.
  common_params params;
  std::unique_ptr<server_context> ctx;
  std::unique_ptr<server_routes> routes;
  std::thread loop;

  std::string info;

  std::mutex mutex;
  std::condition_variable idle;
  int activeRuns = 0;
  bool closing = false;
  std::atomic<bool> stopping{false};
};

namespace {

using State = DecisionRuntime::State;

std::string errorJson(const std::string& message, const char* type) {
  try {
    common_json error = common_json::object();
    error["message"] = message;
    error["type"] = std::string(type);
    common_json out = common_json::object();
    out["error"] = error;
    return out.dump();
  } catch (...) {
    return R"({"error":{"message":"internal error while reporting an error","type":"server_error"}})";
  }
}

DecisionOutcome
failure(DecisionStatus status, const std::string& message, const char* type) {
  return DecisionOutcome{status, errorJson(message, type)};
}

// Container nesting of a JSON text, scanned without recursion and without
// parsing, so a hostile body cannot overflow the stack before it is rejected.
// The body object is one level; the values inside may add
// kDecisionMaxJsonDepth more, as upstream allows for the values it walks (a
// state of 128 nested arrays is accepted, 129 is not).
bool withinDepthLimit(const std::string& text) {
  constexpr int kMaxDepth = kDecisionMaxJsonDepth + 1;
  int depth = 0;
  bool inString = false;
  bool escaped = false;
  for (const char c : text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        inString = false;
      }
      continue;
    }
    if (c == '"') {
      inString = true;
    } else if (c == '{' || c == '[') {
      if (++depth > kMaxDepth) {
        return false;
      }
    } else if ((c == '}' || c == ']') && depth > 0) {
      --depth;
    }
  }
  return true;
}

const char* decisionTypeName(common_decision_type type) {
  switch (type) {
  case COMMON_DECISION_TYPE_OPENJEV:
    return "openjev";
  case COMMON_DECISION_TYPE_LEV:
    return "lev";
  case COMMON_DECISION_TYPE_KEV:
    return "kev";
  case COMMON_DECISION_TYPE_NIMBLE:
    return "nimble";
  case COMMON_DECISION_TYPE_LAYA:
    return "laya";
  case COMMON_DECISION_TYPE_CLEF:
    return "clef";
  case COMMON_DECISION_TYPE_PPLX_DECIDER:
    return "pplx-decider";
  case COMMON_DECISION_TYPE_VLLM_DECISION2:
    return "vllm-decision2";
  case COMMON_DECISION_TYPE_VLLM_D3:
    return "vllm-d3";
  case COMMON_DECISION_TYPE_LFM2_D1:
    return "lfm2-d1";
  case COMMON_DECISION_TYPE_LFM2_D1_OMNI:
    return "lfm2-d1-omni";
  case COMMON_DECISION_TYPE_GRANITE_SWITCH:
    return "granite-switch";
  case COMMON_DECISION_TYPE_NONE:
    return "none";
  default:
    return "unknown";
  }
}

void applyParams(const common_json& p, common_params& params) {
  params.model.path = p.at("model").get<std::string>();
  if (params.model.path.empty()) {
    throw std::invalid_argument("\"model\" must be a non-empty path");
  }
  params.mmproj.path = p.value("mmproj", std::string());
  params.n_ctx = p.value("n_ctx", params.n_ctx);
  params.n_batch = p.value("n_batch", params.n_batch);
  params.n_ubatch = p.value("n_ubatch", params.n_ubatch);
  params.n_parallel = p.value("n_parallel", params.n_parallel);
  params.n_gpu_layers = p.value("n_gpu_layers", params.n_gpu_layers);
  params.cpuparams.n_threads = p.value("n_threads", params.cpuparams.n_threads);
  params.sleep_idle_seconds = p.value("sleep_idle_seconds", -1);
  params.mmproj_use_gpu = p.value("mmproj_use_gpu", params.mmproj_use_gpu);

  // Upstream creates one execution slot per n_parallel and does not check it
  // (the context's sequence count is clamped to at least one, the slot list
  // is not): with 0 slots every request stays deferred forever. Batch sizes
  // of 0 cannot hold a token either.
  if (params.n_parallel < 1) {
    throw std::invalid_argument("\"n_parallel\" must be at least 1");
  }
  if (params.n_batch < 1 || params.n_ubatch < 1) {
    throw std::invalid_argument(
        "\"n_batch\" and \"n_ubatch\" must be at least 1");
  }
  if (params.n_ctx < 0) {
    throw std::invalid_argument(
        "\"n_ctx\" must be 0 (model default) or positive");
  }
  if (p.contains("lora")) {
    for (const auto& item : p.at("lora")) {
      common_adapter_lora_info lora{};
      lora.path = item.at("path").get<std::string>();
      lora.scale = item.value("scale", 1.0F);
      lora.ptr = nullptr;
      params.lora_adapters.push_back(lora);
    }
  }
  // No HTTP: the server's own request threads and endpoints are never used.
  params.endpoint_metrics = false;
  postprocess_cpu_params(params.cpuparams, nullptr);
  postprocess_cpu_params(params.cpuparams_batch, &params.cpuparams);
}

std::string buildInfo(State& d) {
  llama_context* lctx = d.ctx->get_llama_context();
  const llama_model* model = lctx != nullptr ? llama_get_model(lctx) : nullptr;
  if (model == nullptr) {
    throw std::runtime_error("the decision model is not loaded");
  }
  server_decision_context decision;
  decision.init(model);
  if (decision.type == COMMON_DECISION_TYPE_NONE) {
    throw std::invalid_argument(
        "this model has no decision metadata, it is not a decision model");
  }
  const server_context_meta meta = d.ctx->get_meta();

  common_json levels = common_json::object();
  levels["min"] = 2;
  levels["max"] = 10;

  common_json info = common_json::object();
  info["decision_type"] = std::string(decisionTypeName(decision.type));
  // lev answers noul with an expected rating, every other type with the
  // probability of "true" (upstream format_answer).
  info["noul"] = std::string(
      decision.type == COMMON_DECISION_TYPE_LEV ? "expected_rating"
                                                : "probability");
  info["joint"] = decision.is_joint();
  info["shared_prefix"] = decision.can_share_prompt();
  info["images"] = decision.can_use_images() && meta.has_inp_image;
  info["audio"] = decision.can_use_images() && meta.has_inp_audio;
  info["score_levels"] = levels;
  info["max_json_depth"] = kDecisionMaxJsonDepth;
  info["n_ctx"] = meta.slot_n_ctx;
  info["model"] = meta.model_name;
  return info.dump();
}

// Stops and frees everything create() may have started. Safe on a partially
// initialized runtime.
void shutdown(State& d) {
  if (d.ctx) {
    d.ctx->terminate();
  }
  if (d.loop.joinable()) {
    d.loop.join();
  }
  d.routes.reset();
  d.ctx.reset();
}

DecisionStatus statusFromHttp(int httpStatus) {
  // 400 is a rejected request; 501 is "not supported" (e.g. images on a model
  // or engine without image input), also a property of the request.
  if (httpStatus == 400 || httpStatus == 501) {
    return DecisionStatus::InvalidRequest;
  }
  return DecisionStatus::Error;
}

// Rejects a model from its GGUF header, before anything is loaded. A model
// without decision metadata is not only unusable here: loading some of them
// with server defaults aborts the process (an encoder-only model trips
// GGML_ABORT in llama_context::output_reserve during warmup), and an abort
// cannot be caught.
bool checkModelFile(const std::string& path, DecisionOutcome& outcome) {
  std::error_code ec;
  if (!std::filesystem::is_regular_file(path, ec)) {
    outcome = failure(
        DecisionStatus::Error, "model file not found: " + path, "server_error");
    return false;
  }
  const common_gguf_info gguf = common_get_gguf_info(path);
  if (gguf.decision_type == COMMON_DECISION_TYPE_NONE) {
    outcome = failure(
        DecisionStatus::InvalidRequest,
        "this model has no decision metadata (<arch>.decision.type), it is "
        "not a decision model",
        "invalid_request_error");
    return false;
  }
  if (gguf.decision_type == COMMON_DECISION_TYPE_UNKNOWN) {
    outcome = failure(
        DecisionStatus::InvalidRequest,
        "not a supported decision model: its GGUF metadata is unreadable or "
        "names a decision type this runtime does not know",
        "invalid_request_error");
    return false;
  }
  return true;
}

} // namespace

DecisionRuntime::DecisionRuntime(std::unique_ptr<State> state)
    : state_(std::move(state)) {}

DecisionRuntime::Created
DecisionRuntime::create(const std::string& paramsJson) {
  Created created;
  auto d = std::make_unique<State>();
  try {
    applyParams(common_json::parse(paramsJson), d->params);
  } catch (const std::exception& e) {
    created.outcome = failure(
        DecisionStatus::InvalidRequest,
        std::string("invalid params: ") + e.what(),
        "invalid_request_error");
    return created;
  }
  if (!checkModelFile(d->params.model.path, created.outcome)) {
    return created;
  }

  try {
    qvac_fabric_load_backends();
    llama_backend_init();

    d->ctx = std::make_unique<server_context>();
    // Upstream order: the routes constructor registers the sleep callback,
    // which must exist before load_model().
    d->routes = std::make_unique<server_routes>(d->params, *d->ctx);
    if (!d->ctx->load_model(d->params)) {
      shutdown(*d);
      created.outcome = failure(
          DecisionStatus::Error,
          "failed to load the model: " + d->params.model.path,
          "server_error");
      return created;
    }
    // Handlers read the model metadata through this snapshot; take it before
    // the loop starts, while get_meta() may still be called from this thread.
    d->routes->update_meta(*d->ctx);
    d->info = buildInfo(*d);

    server_context* ctx = d->ctx.get();
    d->loop = std::thread([ctx]() {
      try {
        ctx->start_loop();
      } catch (...) {
        // start_loop only returns after terminate(); an exception here would
        // otherwise call std::terminate on the whole process.
      }
    });
  } catch (const std::invalid_argument& e) {
    shutdown(*d);
    created.outcome = failure(
        DecisionStatus::InvalidRequest, e.what(), "invalid_request_error");
    return created;
  } catch (const std::exception& e) {
    shutdown(*d);
    created.outcome = failure(DecisionStatus::Error, e.what(), "server_error");
    return created;
  } catch (...) {
    shutdown(*d);
    created.outcome = failure(
        DecisionStatus::Error,
        "unknown error while loading the model",
        "server_error");
    return created;
  }

  created.outcome = DecisionOutcome{DecisionStatus::Ok, {}};
  created.runtime.reset(new DecisionRuntime(std::move(d)));
  return created;
}

DecisionRuntime::~DecisionRuntime() {
  if (!state_) {
    return;
  }
  State& d = *state_;
  {
    std::unique_lock<std::mutex> lock(d.mutex);
    d.closing = true;
    // Every run in flight sees shouldStop() at its next result poll and
    // returns Cancelled.
    d.stopping.store(true, std::memory_order_release);
    d.idle.wait(lock, [&d]() { return d.activeRuns == 0; });
  }
  try {
    shutdown(d);
  } catch (...) {
  }
}

const std::string& DecisionRuntime::info() const noexcept {
  return state_->info;
}

DecisionOutcome DecisionRuntime::run(
    const std::string& requestJson,
    const std::shared_ptr<const DecisionCancelToken>& cancel) {
  State& d = *state_;
  {
    std::lock_guard<std::mutex> lock(d.mutex);
    if (d.closing) {
      return failure(
          DecisionStatus::Unavailable,
          "the decision engine is shutting down",
          "unavailable_error");
    }
    ++d.activeRuns;
  }

  // Releases the run's slot on every return path.
  struct RunScope {
    State& d;
    ~RunScope() {
      std::lock_guard<std::mutex> lock(d.mutex);
      --d.activeRuns;
      d.idle.notify_all();
    }
  } scope{d};

  // The run holds its own reference to the token for as long as upstream may
  // call this.
  const std::function<bool()> shouldStop = [&d, cancel]() {
    return d.stopping.load(std::memory_order_acquire) ||
           (cancel && cancel->requested());
  };

  if (shouldStop()) {
    return failure(
        DecisionStatus::Cancelled, "the request was cancelled", "cancelled");
  }
  if (!withinDepthLimit(requestJson)) {
    return failure(
        DecisionStatus::InvalidRequest,
        "JSON is nested more than " + std::to_string(kDecisionMaxJsonDepth) +
            " levels deep",
        "invalid_request_error");
  }

  const auto afterThrow = [&shouldStop](DecisionStatus status) {
    return shouldStop() ? DecisionStatus::Cancelled : status;
  };
  server_http_res_ptr res;
  try {
    server_http_req req{
        {}, {}, "/v1/systemone", "", requestJson, {}, shouldStop};
    res = d.routes->post_systemone(req);
  } catch (const std::invalid_argument& e) {
    // llama-server's ex_wrapper (HTTP target, not built here) maps these to
    // 400.
    return failure(
        afterThrow(DecisionStatus::InvalidRequest),
        e.what(),
        "invalid_request_error");
  } catch (const common_json_error& e) {
    return failure(
        afterThrow(DecisionStatus::InvalidRequest),
        e.what(),
        "invalid_request_error");
  } catch (const std::exception& e) {
    return failure(afterThrow(DecisionStatus::Error), e.what(), "server_error");
  } catch (...) {
    return failure(
        afterThrow(DecisionStatus::Error), "unknown error", "server_error");
  }

  // A cancelled request can come back untouched: status 200 and no data. The
  // stop signal decides, never the status alone.
  if (shouldStop()) {
    return failure(
        DecisionStatus::Cancelled, "the request was cancelled", "cancelled");
  }
  if (!res) {
    return failure(
        DecisionStatus::Error,
        "no response from the decision handler",
        "server_error");
  }
  if (res->status != 200) {
    if (res->data.empty()) {
      return failure(
          statusFromHttp(res->status),
          "decision request failed with status " + std::to_string(res->status),
          "server_error");
    }
    return DecisionOutcome{statusFromHttp(res->status), res->data};
  }

  try {
    const common_json result = common_json::parse(res->data);
    if (!result.is_object() || !result.contains("answers")) {
      return failure(
          DecisionStatus::Error,
          "the decision handler returned no answers",
          "server_error");
    }
  } catch (const std::exception& e) {
    return failure(
        DecisionStatus::Error,
        std::string("the decision handler returned invalid JSON: ") + e.what(),
        "server_error");
  }
  return DecisionOutcome{DecisionStatus::Ok, res->data};
}

} // namespace qvac_lib_infer_llamacpp_decision
