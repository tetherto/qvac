// Upstream llama.cpp's decision execution (tools/server server-context), run
// in-process. Upstream keeps decision parsing, prompt rendering, task
// scheduling and answer calculation; this file only owns the server context's
// lifecycle, the request depth guard and the mapping of failures to the
// addon's errors. No HTTP server is created: post_systemone is called directly
// with a request struct.
//
// server-context is linked statically into this addon (from its own vcpkg
// build of the qvac-fabric port); its llama / common / mtmd references resolve
// from the shared fabric runtime.

#include "DecisionContext.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <exception>
#include <filesystem>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <typeinfo>
#include <utility>
#include <vector>

#include <common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <json.h>
#include <llama.h>
#include <log.h>
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

  // Set when upstream's loop ended with an exception: nothing processes
  // requests any more. loopError is written before the flag is released.
  std::atomic<bool> loopDead{false};
  std::string loopError;
  // Set when the loop thread is about to end, however start_loop() returned.
  std::atomic<bool> loopExited{false};
};

namespace {

using State = DecisionContext::State;

[[noreturn]] void fail(DecisionErrorCode code, const std::string& message) {
  throw qvac_errors::StatusError(ADDON_ID, toString(code), message);
}

// A dead loop fails every request with its error instead of letting it wait
// for a result nobody computes. Checked ahead of the stop signal, which the
// dead loop also raises, so it is not reported as a cancellation.
void failIfLoopDead(const State& d, const std::string& where) {
  if (d.loopDead.load(std::memory_order_acquire)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(DecodeFailed),
        where + "the decision loop stopped: " + d.loopError);
  }
}

// Whether @p e is upstream's common_json_error (bad JSON, a value of the wrong
// type). Compared by name as well as by type: the fabric runtime throws it
// with its own type_info, which it does not export, and Linux libc++ matches
// a catch clause by type_info address, so `catch (const common_json_error&)`
// misses it there.
bool isJsonError(const std::exception& e) {
  return dynamic_cast<const common_json_error*>(&e) != nullptr ||
         std::strcmp(typeid(e).name(), typeid(common_json_error).name()) == 0;
}

[[noreturn]] void failRequest(const std::string& message) {
  // "invalid request: " is the marker the JS side turns into err.code
  // DECISION_INVALID_REQUEST (job errors reach JS as their message only).
  fail(InvalidRequest, "invalid request: " + message);
}

// Upstream reports an input that a non-causal model cannot read in one pass
// as a server error ("input (N tokens) is too large to process. increase the
// physical batch size (current batch size: M)"). It is a property of the
// request: returns the addon's message for it, or "" for any other error.
std::string tooLargeForOnePass(const std::string& message) {
  static const std::regex pattern(
      R"(^input \((\d+) tokens\) is too large to process\..*current batch size: (\d+))");
  std::smatch match;
  if (!std::regex_search(message, match, pattern)) {
    return "";
  }
  return "the input is " + match[1].str() +
         " tokens, more than this model reads in one pass (" + match[2].str() +
         "); shorten the state, or load the model with a larger batch_size";
}

// Prefix of a failure inside a batch ("states[3]: "), empty for one state.
std::string at(const std::string& where) {
  return where.empty() ? where : where + ": ";
}

[[noreturn]] void failCancelled() {
  // The job scheduler reports this message as a cancellation.
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

// Whether every value a request carries is nested at most
// DECISION_MAX_JSON_DEPTH containers deep, measured from where the value
// starts: a state (or each of "states"), each question's instructions and
// each criteria entry, as the SDK and upstream count them. The containers
// that frame those values -- the body, "questions", each question, "criteria"
// and "states" -- are recognised only at their fixed places and do not count.
// Any other value is held to the same limit from where it starts, so the
// whole text is at most a few levels deeper than the limit. Scanned without
// recursion and without parsing, so a hostile body cannot overflow the stack
// before it is rejected. A key written with escapes is not recognised; its
// value then counts as one payload, which only makes the limit stricter.
bool withinDepthLimit(const std::string& text) {
  enum class Frame { Body, Questions, Question, Criteria, States, Payload };
  struct Level {
    Frame frame;
    bool isObject;
    int payloadDepth;     // containers so far inside the value (Payload only)
    bool expectKey;       // objects: the next string is a key
    std::string_view key; // objects: the key of the value being read
  };
  std::vector<Level> stack;
  stack.reserve(DECISION_MAX_JSON_DEPTH + 8);

  // The frame of a container opening as a value of the current level.
  const auto childFrame = [&stack](bool isObject) -> Frame {
    if (stack.empty()) {
      return isObject ? Frame::Body : Frame::Payload;
    }
    const Level& parent = stack.back();
    switch (parent.frame) {
    case Frame::Body:
      if (isObject && parent.key == "questions") {
        return Frame::Questions;
      }
      if (!isObject && parent.key == "states") {
        return Frame::States;
      }
      return Frame::Payload;
    case Frame::Questions:
      return isObject ? Frame::Question : Frame::Payload;
    case Frame::Question:
      return parent.key == "criteria" ? Frame::Criteria : Frame::Payload;
    default:
      return Frame::Payload;
    }
  };

  bool inString = false;
  bool escaped = false;
  size_t stringStart = 0;
  for (size_t i = 0; i < text.size(); ++i) {
    const char c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        inString = false;
        if (!stack.empty() && stack.back().isObject && stack.back().expectKey) {
          stack.back().key =
              std::string_view(text).substr(stringStart, i - stringStart);
        }
      }
      continue;
    }
    if (c == '"') {
      inString = true;
      stringStart = i + 1;
    } else if (c == '{' || c == '[') {
      const bool isObject = c == '{';
      Level level{childFrame(isObject), isObject, 0, isObject, {}};
      if (level.frame == Frame::Payload) {
        const bool nested =
            !stack.empty() && stack.back().frame == Frame::Payload;
        level.payloadDepth = nested ? stack.back().payloadDepth + 1 : 1;
        if (level.payloadDepth > DECISION_MAX_JSON_DEPTH) {
          return false;
        }
      }
      stack.push_back(level);
    } else if (c == '}' || c == ']') {
      if (!stack.empty()) {
        stack.pop_back();
      }
    } else if (!stack.empty() && stack.back().isObject) {
      if (c == ':') {
        stack.back().expectKey = false;
      } else if (c == ',') {
        stack.back().expectKey = true;
        stack.back().key = {};
      }
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
  case COMMON_DECISION_TYPE_H2O_LIGHTNING:
    return "h2o-lightning";
  case COMMON_DECISION_TYPE_MINICPM_OCR_JEV:
    return "openbmb-minicpm-ocr-jev";
  case COMMON_DECISION_TYPE_LFM3_D1:
    return "lfm3-d1";
  case COMMON_DECISION_TYPE_LFM3_D1_OMNI:
    return "lfm3-d1-omni";
  case COMMON_DECISION_TYPE_NONE:
    return "none";
  default:
    return "unknown";
  }
}

} // namespace

std::string noulSemantics(common_decision_type type) {
  switch (type) {
  // upstream format_answer: lev reads noul from its rating scale and answers
  // the expected rating, normalized to 0..1.
  case COMMON_DECISION_TYPE_LEV:
    return "expected_rating";
  // Every other type answers the probability of the "true" option.
  case COMMON_DECISION_TYPE_OPENJEV:
  case COMMON_DECISION_TYPE_KEV:
  case COMMON_DECISION_TYPE_NIMBLE:
  case COMMON_DECISION_TYPE_LAYA:
  case COMMON_DECISION_TYPE_CLEF:
  case COMMON_DECISION_TYPE_PPLX_DECIDER:
  case COMMON_DECISION_TYPE_VLLM_DECISION2:
  case COMMON_DECISION_TYPE_VLLM_D3:
  case COMMON_DECISION_TYPE_LFM2_D1:
  case COMMON_DECISION_TYPE_LFM2_D1_OMNI:
  case COMMON_DECISION_TYPE_GRANITE_SWITCH:
  case COMMON_DECISION_TYPE_H2O_LIGHTNING:
  case COMMON_DECISION_TYPE_MINICPM_OCR_JEV:
  case COMMON_DECISION_TYPE_LFM3_D1:
  case COMMON_DECISION_TYPE_LFM3_D1_OMNI:
    return "probability";
  // A type a rebase adds is not assumed to be either until it is listed here.
  default:
    return "unknown";
  }
}

namespace {

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
  info["noul"] = noulSemantics(decision.type);
  info["joint"] = decision.is_joint();
  info["shared_prefix"] = decision.can_share_prompt();
  info["images"] = decision.can_use_images() && meta.has_inp_image;
  info["audio"] = decision.can_use_images() && meta.has_inp_audio;
  info["score_levels"] = levels;
  info["max_json_depth"] = DECISION_MAX_JSON_DEPTH;
  info["n_ctx"] = meta.slot_n_ctx;
  // The longest input (a state with one question and its options, in
  // tokens) a request can have. A non-causal model reads it in one pass of at
  // most n_ubatch tokens. A causal one splits it but keeps it in the KV cache
  // and needs a token of it left; each question of each state takes a slot,
  // and with the default unified cache upstream gives every slot the whole
  // context while all of them share it. So the bound is an equal share of the
  // context, which every slot has even when all are busy; without the unified
  // cache that is the slot's own context.
  const int nParallel = std::max(1, d.params.n_parallel);
  const int causalShare = std::min(
      meta.slot_n_ctx, static_cast<int>(llama_n_ctx(lctx)) / nParallel);
  info["max_input_tokens"] =
      llama_get_causal_attn(lctx)
          ? causalShare - 1
          : std::min(static_cast<int>(llama_n_ubatch(lctx)), meta.slot_n_ctx);
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
    // start_loop() marks the queue running on entry, so a terminate() that
    // lands before the loop thread gets there is overwritten and the loop
    // never ends. Repeat it until the thread is out.
    while (!d.loopExited.load(std::memory_order_acquire)) {
      d.ctx->terminate();
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
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

    // start_loop only returns after terminate(). It does not catch what its
    // task processing throws: record it, so requests fail with it rather
    // than wait for results nobody computes (and the process does not call
    // std::terminate). shutdown() joins the thread before State is freed.
    State* state = &d;
    d.loop = std::thread([state]() {
      const auto died = [state](const std::string& error) {
        LOG_ERR("decision loop stopped: %s\n", error.c_str());
        state->loopError = error;
        state->loopDead.store(true, std::memory_order_release);
      };
      try {
        state->ctx->start_loop();
      } catch (const std::exception& e) {
        died(e.what());
      } catch (...) {
        died("unknown error");
      }
      state->loopExited.store(true, std::memory_order_release);
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

namespace {

// One /v1/systemone request (one state) through upstream's handler. @p where
// names the state inside a batch, for the error messages.
std::string runOne(
    State& d, const std::string& requestJson, const std::function<bool()>& stop,
    const std::string& where) {
  server_http_res_ptr res;
  try {
    server_http_req req{{}, {}, "/v1/systemone", "", requestJson, {}, stop};
    res = d.routes->post_systemone(req);
  } catch (const std::invalid_argument& e) {
    // llama-server's ex_wrapper (HTTP target, not built here) maps these to
    // 400.
    failIfLoopDead(d, at(where));
    if (stop()) {
      failCancelled();
    }
    failRequest(at(where) + e.what());
  } catch (const common_json_error& e) {
    failIfLoopDead(d, at(where));
    if (stop()) {
      failCancelled();
    }
    failRequest(at(where) + e.what());
  } catch (const std::exception& e) {
    failIfLoopDead(d, at(where));
    if (stop()) {
      failCancelled();
    }
    if (isJsonError(e)) {
      failRequest(at(where) + e.what());
    }
    fail(DecodeFailed, at(where) + e.what());
  } catch (...) {
    failIfLoopDead(d, at(where));
    if (stop()) {
      failCancelled();
    }
    fail(DecodeFailed, at(where) + "unknown error");
  }

  // A cancelled request can come back untouched: status 200 and no data. The
  // stop signal decides, never the status alone; a dead loop comes first, as
  // it raises the stop signal too.
  failIfLoopDead(d, at(where));
  if (stop()) {
    failCancelled();
  }
  if (!res) {
    fail(DecodeFailed, at(where) + "no response from the decision handler");
  }
  if (res->status != 200) {
    const std::string message = res->data.empty()
                                    ? "decision request failed with status " +
                                          std::to_string(res->status)
                                    : errorMessage(res->data);
    // 400 is a rejected request; 501 is "not supported" (e.g. images on a
    // model without image input), also a property of the request.
    if (res->status == 400 || res->status == 501) {
      failRequest(at(where) + message);
    }
    if (const std::string tooLarge = tooLargeForOnePass(message);
        !tooLarge.empty()) {
      failRequest(at(where) + tooLarge);
    }
    fail(DecodeFailed, at(where) + message);
  }

  try {
    const common_json result = common_json::parse(res->data);
    if (!result.is_object() || !result.contains("answers")) {
      fail(
          DecodeFailed, at(where) + "the decision handler returned no answers");
    }
  } catch (const qvac_errors::StatusError&) {
    throw;
  } catch (const std::exception& e) {
    fail(
        DecodeFailed,
        at(where) + "the decision handler returned invalid JSON: " + e.what());
  }
  return std::move(res->data);
}

// A batch: one request per state, sent to upstream concurrently so its slots
// batch them, at most one in flight per slot. Results keep the input order.
// The first failure stops the other states and fails the batch.
std::string runStates(
    State& d, const common_json& request, const std::function<bool()>& stop) {
  const common_json& states = request.at("states");
  if (request.contains("state")) {
    failRequest("give either \"state\" or \"states\", not both");
  }
  if (!states.is_array() || states.empty()) {
    failRequest("\"states\" must be a non-empty array");
  }

  common_json shared = request;
  shared.erase("states");
  std::vector<std::string> bodies;
  bodies.reserve(states.size());
  for (const common_json& state : states) {
    shared["state"] = state;
    bodies.push_back(shared.dump());
  }

  const size_t n = bodies.size();
  std::vector<std::string> results(n);
  std::atomic<size_t> next{0};
  std::atomic<bool> failed{false};
  std::exception_ptr firstError;
  std::mutex errorMutex;
  const auto batchStop = [&stop, &failed]() {
    return failed.load(std::memory_order_acquire) || stop();
  };

  const auto worker = [&]() {
    for (size_t i = next.fetch_add(1); i < n && !batchStop();
         i = next.fetch_add(1)) {
      try {
        results[i] = runOne(
            d, bodies[i], batchStop, "states[" + std::to_string(i) + "]");
      } catch (...) {
        // A sibling's stop makes the others end as cancelled; only the
        // failure that stopped them is reported.
        std::lock_guard<std::mutex> lock(errorMutex);
        if (!failed.exchange(true, std::memory_order_acq_rel)) {
          firstError = std::current_exception();
        }
      }
    }
  };

  const size_t workers =
      std::min(n, static_cast<size_t>(std::max(1, d.params.n_parallel)));
  std::vector<std::thread> threads;
  threads.reserve(workers - 1);
  for (size_t w = 1; w < workers; ++w) {
    threads.emplace_back(worker);
  }
  worker();
  for (std::thread& t : threads) {
    t.join();
  }

  if (stop()) {
    failCancelled();
  }
  if (firstError) {
    std::rethrow_exception(firstError);
  }
  std::string out = "[";
  for (size_t i = 0; i < n; ++i) {
    if (i > 0) {
      out += ',';
    }
    out += results[i];
  }
  out += ']';
  return out;
}

} // namespace

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

  // A dead loop stops the request too, so an in-flight one returns.
  const std::function<bool()> stop = [&d, &shouldStop]() {
    return d.stopping.load(std::memory_order_acquire) ||
           d.loopDead.load(std::memory_order_acquire) ||
           (shouldStop && shouldStop());
  };

  failIfLoopDead(d, "");
  if (stop()) {
    failCancelled();
  }
  if (!withinDepthLimit(requestJson)) {
    failRequest(
        "a value in the request is nested more than " +
        std::to_string(DECISION_MAX_JSON_DEPTH) + " levels deep");
  }

  // Parsed only to find "states": the depth guard above bounds the recursion.
  // A body that is not JSON goes to upstream as is, which rejects it.
  common_json request;
  try {
    request = common_json::parse(requestJson);
  } catch (const std::exception&) {
    return runOne(d, requestJson, stop, "");
  }
  if (request.is_object() && request.contains("states")) {
    return runStates(d, request, stop);
  }
  return runOne(d, requestJson, stop, "");
}

} // namespace qvac_lib_inference_addon_decision
