// Upstream llama.cpp's decision execution (tools/server server-context), run
// in-process. Upstream keeps decision parsing, prompt rendering, task
// scheduling and answer calculation; this file only owns the server context's
// lifecycle, the request depth guard and the mapping of failures to the
// addon's errors. No HTTP server is created: post_systemone is called directly
// with a request struct.
//
// server-context is linked statically into this addon (from @qvac/fabric's
// platform package); its llama / common / mtmd references resolve from the
// shared fabric runtime.

#include "DecisionContext.hpp"

#include <atomic>
#include <condition_variable>
#include <exception>
#include <filesystem>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

#include <common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <json.h>
#include <llama.h>
#include <qvac-fabric.h>
#include <server-context.h>
#include <server-decision.h>
#include <server-http.h>

#include "addon/DecisionErrors.hpp"

namespace qvac_lib_inference_addon_decision {

using namespace errors;

struct DecisionContext::State {
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

using State = DecisionContext::State;

[[noreturn]] void fail(DecisionErrorCode code, const std::string& message) {
  throw qvac_errors::StatusError(ADDON_ID, toString(code), message);
}

[[noreturn]] void failRequest(const std::string& message) {
  // "invalid request: " is the marker the JS side turns into err.code
  // DECISION_INVALID_REQUEST (job errors reach JS as their message only).
  fail(InvalidRequest, "invalid request: " + message);
}

[[noreturn]] void failCancelled() {
  // The job scheduler reports this as a cancellation, as with LayaModel.
  throw std::runtime_error("Job cancelled");
}

// The message of upstream's {"error": {"message": ...}} payload, or the
// payload itself.
std::string errorMessage(const std::string& payload) {
  try {
    const common_json j = common_json::parse(payload);
    if (j.contains("error") && j["error"].contains("message")) {
      return j["error"]["message"].get<std::string>();
    }
  } catch (const std::exception&) {
  }
  return payload;
}

// Container nesting of a JSON text, scanned without recursion and without
// parsing, so a hostile body cannot overflow the stack before it is rejected.
// The body object is one level; the values inside may add
// DECISION_MAX_JSON_DEPTH more, as upstream allows for the values it walks (a
// state of 128 nested arrays is accepted, 129 is not).
bool withinDepthLimit(const std::string& text) {
  constexpr int kMaxDepth = DECISION_MAX_JSON_DEPTH + 1;
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

std::string buildInfo(State& d) {
  llama_context* lctx = d.ctx->get_llama_context();
  const llama_model* model = lctx != nullptr ? llama_get_model(lctx) : nullptr;
  if (model == nullptr) {
    fail(UnableToLoadModel, "the decision model is not loaded");
  }
  server_decision_context decision;
  decision.init(model);
  if (decision.type == COMMON_DECISION_TYPE_NONE) {
    fail(
        UnsupportedModel,
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
  info["max_json_depth"] = DECISION_MAX_JSON_DEPTH;
  info["n_ctx"] = meta.slot_n_ctx;
  info["model"] = meta.model_name;
  return info.dump();
}

// Stops and frees everything the constructor may have started. Safe on a
// partially initialized context.
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

// Rejects a model from its GGUF header, before anything is loaded. A model
// without decision metadata is not only unusable here: loading some of them
// with server defaults aborts the process (an encoder-only model trips
// GGML_ABORT in llama_context::output_reserve during warmup), and an abort
// cannot be caught.
void checkModelFile(const std::string& path) {
  std::error_code ec;
  if (!std::filesystem::is_regular_file(path, ec)) {
    fail(UnableToLoadModel, "model file not found: " + path);
  }
  const common_gguf_info gguf = common_get_gguf_info(path);
  if (gguf.decision_type == COMMON_DECISION_TYPE_NONE) {
    fail(
        UnsupportedModel,
        "this model has no decision metadata (<arch>.decision.type), it is "
        "not a decision model");
  }
  if (gguf.decision_type == COMMON_DECISION_TYPE_UNKNOWN) {
    fail(
        UnsupportedModel,
        "not a supported decision model: its GGUF metadata is unreadable or "
        "names a decision type this addon does not know");
  }
}

} // namespace

DecisionContext::DecisionContext(const common_params& params)
    : state_(std::make_unique<State>()) {
  State& d = *state_;
  d.params = params;
  // No HTTP: the server's own request threads and endpoints are never used.
  d.params.endpoint_metrics = false;
  postprocess_cpu_params(d.params.cpuparams, nullptr);
  postprocess_cpu_params(d.params.cpuparams_batch, &d.params.cpuparams);

  checkModelFile(d.params.model.path);

  try {
    qvac_fabric_load_backends();
    llama_backend_init();

    d.ctx = std::make_unique<server_context>();
    // Upstream order: the routes constructor registers the sleep callback,
    // which must exist before load_model().
    d.routes = std::make_unique<server_routes>(d.params, *d.ctx);
    if (!d.ctx->load_model(d.params)) {
      fail(
          UnableToLoadModel,
          "failed to load the model: " + d.params.model.path);
    }
    // Handlers read the model metadata through this snapshot; take it before
    // the loop starts, while get_meta() may still be called from this thread.
    d.routes->update_meta(*d.ctx);
    d.info = buildInfo(d);

    server_context* ctx = d.ctx.get();
    d.loop = std::thread([ctx]() {
      try {
        ctx->start_loop();
      } catch (...) {
        // start_loop only returns after terminate(); an exception here would
        // otherwise call std::terminate on the whole process.
      }
    });
  } catch (const qvac_errors::StatusError&) {
    shutdown(d);
    throw;
  } catch (const std::exception& e) {
    shutdown(d);
    fail(UnableToLoadModel, e.what());
  } catch (...) {
    shutdown(d);
    fail(UnableToLoadModel, "unknown error while loading the model");
  }
}

DecisionContext::~DecisionContext() {
  State& d = *state_;
  {
    std::unique_lock<std::mutex> lock(d.mutex);
    d.closing = true;
    // Every run in flight sees its stop at its next result poll and returns.
    d.stopping.store(true, std::memory_order_release);
    d.idle.wait(lock, [&d]() { return d.activeRuns == 0; });
  }
  try {
    shutdown(d);
  } catch (...) {
  }
}

const std::string& DecisionContext::info() const noexcept {
  return state_->info;
}

std::string DecisionContext::run(
    const std::string& requestJson, const std::function<bool()>& shouldStop) {
  State& d = *state_;
  {
    std::lock_guard<std::mutex> lock(d.mutex);
    if (d.closing) {
      failCancelled();
    }
    ++d.activeRuns;
  }

  // Releases the run's slot on every return path.
  struct RunScope {
    State& d;
    explicit RunScope(State& state) : d(state) {}
    RunScope(const RunScope&) = delete;
    RunScope& operator=(const RunScope&) = delete;
    ~RunScope() {
      std::lock_guard<std::mutex> lock(d.mutex);
      --d.activeRuns;
      d.idle.notify_all();
    }
  } scope(d);

  const std::function<bool()> stop = [&d, &shouldStop]() {
    return d.stopping.load(std::memory_order_acquire) ||
           (shouldStop && shouldStop());
  };

  if (stop()) {
    failCancelled();
  }
  if (!withinDepthLimit(requestJson)) {
    failRequest(
        "JSON is nested more than " + std::to_string(DECISION_MAX_JSON_DEPTH) +
        " levels deep");
  }

  server_http_res_ptr res;
  try {
    server_http_req req{{}, {}, "/v1/systemone", "", requestJson, {}, stop};
    res = d.routes->post_systemone(req);
  } catch (const std::invalid_argument& e) {
    // llama-server's ex_wrapper (HTTP target, not built here) maps these to
    // 400.
    if (stop()) {
      failCancelled();
    }
    failRequest(e.what());
  } catch (const common_json_error& e) {
    if (stop()) {
      failCancelled();
    }
    failRequest(e.what());
  } catch (const std::exception& e) {
    if (stop()) {
      failCancelled();
    }
    fail(DecodeFailed, e.what());
  } catch (...) {
    if (stop()) {
      failCancelled();
    }
    fail(DecodeFailed, "unknown error");
  }

  // A cancelled request can come back untouched: status 200 and no data. The
  // stop signal decides, never the status alone.
  if (stop()) {
    failCancelled();
  }
  if (!res) {
    fail(DecodeFailed, "no response from the decision handler");
  }
  if (res->status != 200) {
    const std::string message = res->data.empty()
                                    ? "decision request failed with status " +
                                          std::to_string(res->status)
                                    : errorMessage(res->data);
    // 400 is a rejected request; 501 is "not supported" (e.g. images on a
    // model without image input), also a property of the request.
    if (res->status == 400 || res->status == 501) {
      failRequest(message);
    }
    fail(DecodeFailed, message);
  }

  try {
    const common_json result = common_json::parse(res->data);
    if (!result.is_object() || !result.contains("answers")) {
      fail(DecodeFailed, "the decision handler returned no answers");
    }
  } catch (const qvac_errors::StatusError&) {
    throw;
  } catch (const std::exception& e) {
    fail(
        DecodeFailed,
        std::string("the decision handler returned invalid JSON: ") + e.what());
  }
  return std::move(res->data);
}

} // namespace qvac_lib_inference_addon_decision
