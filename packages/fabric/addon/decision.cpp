// QVAC-owned C bridge over upstream llama.cpp's decision execution
// (tools/server server-context), declared in qvac-fabric.h.
//
// Upstream keeps decision parsing, prompt rendering, task scheduling and answer
// calculation; this file only owns the engine lifecycle, cancellation, the
// request depth guard and the mapping of outcomes to explicit statuses. No HTTP
// server is created: post_systemone is called directly with a request struct.

#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include <common.h>
#include <json.h>
#include <llama.h>
#include <server-context.h>
#include <server-decision.h>
#include <server-http.h>

#include "qvac-fabric.h"

struct qvac_fabric_decision_cancel {
  std::atomic<bool> requested{false};
  std::atomic<int> refs{1};
};

struct qvac_fabric_decision {
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

char* dupString(const std::string& s) {
  auto* out = static_cast<char*>(std::malloc(s.size() + 1));
  if (out == nullptr) {
    return nullptr;
  }
  std::memcpy(out, s.data(), s.size());
  out[s.size()] = '\0';
  return out;
}

void setOut(char** out, const std::string& s) {
  if (out != nullptr) {
    *out = dupString(s);
  }
}

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

// Container nesting of a JSON text, scanned without recursion and without
// parsing, so a hostile body cannot overflow the stack before it is rejected.
// The body object is one level; the values inside may add
// QVAC_FABRIC_DECISION_MAX_JSON_DEPTH more, as upstream allows for the values
// it walks (a state of 128 nested arrays is accepted, 129 is not).
bool withinDepthLimit(const char* text) {
  constexpr int kMaxDepth = QVAC_FABRIC_DECISION_MAX_JSON_DEPTH + 1;
  int depth = 0;
  bool inString = false;
  bool escaped = false;
  for (const char* p = text; *p != '\0'; ++p) {
    const char c = *p;
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

std::string buildInfo(qvac_fabric_decision& d) {
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
  info["max_json_depth"] = QVAC_FABRIC_DECISION_MAX_JSON_DEPTH;
  info["n_ctx"] = meta.slot_n_ctx;
  info["model"] = meta.model_name;
  return info.dump();
}

// Stops and frees everything create() may have started. Safe on a partially
// initialized engine.
void shutdown(qvac_fabric_decision& d) {
  if (d.ctx) {
    d.ctx->terminate();
  }
  if (d.loop.joinable()) {
    d.loop.join();
  }
  d.routes.reset();
  d.ctx.reset();
}

int statusFromHttp(int httpStatus) {
  // 400 is a rejected request; 501 is "not supported" (e.g. images on a model
  // or engine without image input), also a property of the request.
  if (httpStatus == 400 || httpStatus == 501) {
    return QVAC_FABRIC_DECISION_INVALID_REQUEST;
  }
  return QVAC_FABRIC_DECISION_ERROR;
}

void releaseCancel(qvac_fabric_decision_cancel* c) {
  if (c != nullptr && c->refs.fetch_sub(1, std::memory_order_acq_rel) == 1) {
    delete c;
  }
}

} // namespace

extern "C" {

QVAC_FABRIC_API int qvac_fabric_decision_create(
    const char* params_json, qvac_fabric_decision** out, char** error_json) {
  if (out != nullptr) {
    *out = nullptr;
  }
  if (error_json != nullptr) {
    *error_json = nullptr;
  }
  if (params_json == nullptr || out == nullptr) {
    setOut(
        error_json,
        errorJson("params_json and out are required", "invalid_request_error"));
    return QVAC_FABRIC_DECISION_INVALID_REQUEST;
  }

  auto d = std::make_unique<qvac_fabric_decision>();
  try {
    applyParams(common_json::parse(params_json), d->params);
  } catch (const std::exception& e) {
    setOut(
        error_json,
        errorJson(
            std::string("invalid params: ") + e.what(),
            "invalid_request_error"));
    return QVAC_FABRIC_DECISION_INVALID_REQUEST;
  }

  // Check the decision type in the GGUF header before loading anything. A
  // model without decision metadata is not only unusable here: loading some
  // of them with server defaults aborts the process (an encoder-only model
  // trips GGML_ABORT in llama_context::output_reserve during warmup), and an
  // abort cannot be caught.
  {
    std::error_code ec;
    if (!std::filesystem::is_regular_file(d->params.model.path, ec)) {
      setOut(
          error_json,
          errorJson(
              "model file not found: " + d->params.model.path, "server_error"));
      return QVAC_FABRIC_DECISION_ERROR;
    }
    const common_gguf_info gguf = common_get_gguf_info(d->params.model.path);
    if (gguf.decision_type == COMMON_DECISION_TYPE_NONE) {
      setOut(
          error_json,
          errorJson(
              "this model has no decision metadata (<arch>.decision.type), "
              "it is not a decision model",
              "invalid_request_error"));
      return QVAC_FABRIC_DECISION_INVALID_REQUEST;
    }
    if (gguf.decision_type == COMMON_DECISION_TYPE_UNKNOWN) {
      setOut(
          error_json,
          errorJson(
              "not a supported decision model: its GGUF metadata is "
              "unreadable or names a decision type this runtime does not know",
              "invalid_request_error"));
      return QVAC_FABRIC_DECISION_INVALID_REQUEST;
    }
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
      setOut(
          error_json,
          errorJson(
              "failed to load the model: " + d->params.model.path,
              "server_error"));
      return QVAC_FABRIC_DECISION_ERROR;
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
    setOut(error_json, errorJson(e.what(), "invalid_request_error"));
    return QVAC_FABRIC_DECISION_INVALID_REQUEST;
  } catch (const std::exception& e) {
    shutdown(*d);
    setOut(error_json, errorJson(e.what(), "server_error"));
    return QVAC_FABRIC_DECISION_ERROR;
  } catch (...) {
    shutdown(*d);
    setOut(
        error_json,
        errorJson("unknown error while loading the model", "server_error"));
    return QVAC_FABRIC_DECISION_ERROR;
  }

  *out = d.release();
  return QVAC_FABRIC_DECISION_OK;
}

QVAC_FABRIC_API char* qvac_fabric_decision_info(qvac_fabric_decision* d) {
  return d == nullptr ? nullptr : dupString(d->info);
}

QVAC_FABRIC_API qvac_fabric_decision_cancel*
qvac_fabric_decision_cancel_create(void) {
  return new (std::nothrow) qvac_fabric_decision_cancel();
}

QVAC_FABRIC_API void
qvac_fabric_decision_cancel_retain(qvac_fabric_decision_cancel* c) {
  if (c != nullptr) {
    c->refs.fetch_add(1, std::memory_order_relaxed);
  }
}

QVAC_FABRIC_API void
qvac_fabric_decision_cancel_release(qvac_fabric_decision_cancel* c) {
  releaseCancel(c);
}

QVAC_FABRIC_API void
qvac_fabric_decision_cancel_request(qvac_fabric_decision_cancel* c) {
  if (c != nullptr) {
    c->requested.store(true, std::memory_order_release);
  }
}

QVAC_FABRIC_API int qvac_fabric_decision_run(
    qvac_fabric_decision* d, const char* request_json,
    qvac_fabric_decision_cancel* cancel, char** result_json) {
  if (result_json != nullptr) {
    *result_json = nullptr;
  }
  if (d == nullptr || request_json == nullptr) {
    setOut(
        result_json,
        errorJson(
            "engine and request_json are required", "invalid_request_error"));
    return QVAC_FABRIC_DECISION_INVALID_REQUEST;
  }

  {
    std::lock_guard<std::mutex> lock(d->mutex);
    if (d->closing) {
      setOut(
          result_json,
          errorJson(
              "the decision engine is shutting down", "unavailable_error"));
      return QVAC_FABRIC_DECISION_UNAVAILABLE;
    }
    ++d->activeRuns;
  }
  qvac_fabric_decision_cancel_retain(cancel);

  // Releases the run's slot and token on every return path.
  struct RunScope {
    qvac_fabric_decision* d;
    qvac_fabric_decision_cancel* cancel;
    ~RunScope() {
      releaseCancel(cancel);
      std::lock_guard<std::mutex> lock(d->mutex);
      --d->activeRuns;
      d->idle.notify_all();
    }
  } scope{d, cancel};

  const std::function<bool()> shouldStop = [d, cancel]() {
    return d->stopping.load(std::memory_order_acquire) ||
           (cancel != nullptr &&
            cancel->requested.load(std::memory_order_acquire));
  };

  if (shouldStop()) {
    setOut(result_json, errorJson("the request was cancelled", "cancelled"));
    return QVAC_FABRIC_DECISION_CANCELLED;
  }
  if (!withinDepthLimit(request_json)) {
    setOut(
        result_json,
        errorJson(
            "JSON is nested more than " +
                std::to_string(QVAC_FABRIC_DECISION_MAX_JSON_DEPTH) +
                " levels deep",
            "invalid_request_error"));
    return QVAC_FABRIC_DECISION_INVALID_REQUEST;
  }

  server_http_res_ptr res;
  try {
    server_http_req req{
        {}, {}, "/v1/systemone", "", request_json, {}, shouldStop};
    res = d->routes->post_systemone(req);
  } catch (const std::invalid_argument& e) {
    // llama-server's ex_wrapper (HTTP target, not built here) maps these to
    // 400.
    setOut(result_json, errorJson(e.what(), "invalid_request_error"));
    return shouldStop() ? QVAC_FABRIC_DECISION_CANCELLED
                        : QVAC_FABRIC_DECISION_INVALID_REQUEST;
  } catch (const common_json_error& e) {
    setOut(result_json, errorJson(e.what(), "invalid_request_error"));
    return shouldStop() ? QVAC_FABRIC_DECISION_CANCELLED
                        : QVAC_FABRIC_DECISION_INVALID_REQUEST;
  } catch (const std::exception& e) {
    setOut(result_json, errorJson(e.what(), "server_error"));
    return shouldStop() ? QVAC_FABRIC_DECISION_CANCELLED
                        : QVAC_FABRIC_DECISION_ERROR;
  } catch (...) {
    setOut(result_json, errorJson("unknown error", "server_error"));
    return shouldStop() ? QVAC_FABRIC_DECISION_CANCELLED
                        : QVAC_FABRIC_DECISION_ERROR;
  }

  // A cancelled request can come back untouched: status 200 and no data. The
  // stop signal decides, never the status alone.
  if (shouldStop()) {
    setOut(result_json, errorJson("the request was cancelled", "cancelled"));
    return QVAC_FABRIC_DECISION_CANCELLED;
  }
  if (!res) {
    setOut(
        result_json,
        errorJson("no response from the decision handler", "server_error"));
    return QVAC_FABRIC_DECISION_ERROR;
  }
  if (res->status != 200) {
    setOut(
        result_json,
        res->data.empty() ? errorJson(
                                "decision request failed with status " +
                                    std::to_string(res->status),
                                "server_error")
                          : res->data);
    return statusFromHttp(res->status);
  }

  try {
    const common_json result = common_json::parse(res->data);
    if (!result.is_object() || !result.contains("answers")) {
      setOut(
          result_json,
          errorJson(
              "the decision handler returned no answers", "server_error"));
      return QVAC_FABRIC_DECISION_ERROR;
    }
  } catch (const std::exception& e) {
    setOut(
        result_json,
        errorJson(
            std::string("the decision handler returned invalid JSON: ") +
                e.what(),
            "server_error"));
    return QVAC_FABRIC_DECISION_ERROR;
  }
  setOut(result_json, res->data);
  return QVAC_FABRIC_DECISION_OK;
}

QVAC_FABRIC_API void qvac_fabric_decision_destroy(qvac_fabric_decision* d) {
  if (d == nullptr) {
    return;
  }
  {
    std::unique_lock<std::mutex> lock(d->mutex);
    d->closing = true;
    // Every run in flight sees shouldStop() at its next result poll and
    // returns CANCELLED.
    d->stopping.store(true, std::memory_order_release);
    d->idle.wait(lock, [d]() { return d->activeRuns == 0; });
  }
  try {
    shutdown(*d);
  } catch (...) {
  }
  delete d;
}

QVAC_FABRIC_API void qvac_fabric_decision_free_string(char* s) { std::free(s); }

} // extern "C"
