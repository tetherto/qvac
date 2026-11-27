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
#include <exception>
#include <filesystem>
#include <mutex>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string_view>
#include <system_error>
#include <thread>
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
  // Batch request bodies serialized so far (one per state a worker claims).
  std::atomic<size_t> batchBodies{0};
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

// A raised stop signal: the loop's error when the loop died, which raises the
// signal too, otherwise a cancellation.
[[noreturn]] void failStopped(const State& d, const std::string& where) {
  failIfLoopDead(d, where);
  failCancelled();
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
// each criteria entry, as the SDK counts them. The containers
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

namespace {

// Whether upstream's own question parser accepts a score question with
// @p criteria for this model, with or without instructions (a few types take
// none, or must not get any).
bool acceptsScore(
    const server_decision_context& decision, const common_json& criteria) {
  for (const bool withInstructions : {true, false}) {
    common_json question = common_json::object();
    question["type"] = "score";
    question["criteria"] = criteria;
    if (withInstructions) {
      question["instructions"] = "x";
    }
    common_json questions = common_json::object();
    questions["q"] = question;
    common_json body = common_json::object();
    body["state"] = "x";
    body["questions"] = questions;
    try {
      (void)decision.parse_questions(body);
      return true;
    } catch (const std::exception&) {
    }
  }
  return false;
}

common_json
scoreLevels(const server_decision_context& decision, const llama_model* model) {
  // Upstream's limits differ by type (h2o-lightning from one level up to its
  // label count, minicpm-ocr-jev no score questions at all, most from 2 to
  // 10), and the option count is private, so the parser is asked, at load.
  // h2o-lightning's labels are distinct single tokens, so no type takes more
  // levels than the vocabulary has tokens; every other type takes at most 255.
  const size_t limit = std::max<size_t>(
      255,
      static_cast<size_t>(
          std::max(0, llama_vocab_n_tokens(llama_model_get_vocab(model)))));
  const auto range = levelRange(
      [&decision](size_t n) {
        common_json criteria = common_json::array();
        for (size_t i = 0; i < n; ++i) {
          criteria.push_back("level " + std::to_string(i));
        }
        return acceptsScore(decision, criteria);
      },
      limit);
  if (!range) {
    return common_json(nullptr);
  }
  common_json levels = common_json::object();
  levels["min"] = static_cast<int64_t>(range->min);
  levels["max"] = static_cast<int64_t>(range->max);
  return levels;
}

} // namespace

std::optional<LevelRange>
levelRange(const std::function<bool(size_t)>& accepts, size_t limit) {
  // The lowest: every type starts at 1 or 2, so a short scan finds it, and a
  // type none of whose first counts is accepted takes no score questions.
  constexpr size_t kLowestScan = 16;
  size_t lowest = 0;
  for (size_t n = 1; n <= std::min(limit, kLowestScan) && lowest == 0; ++n) {
    if (accepts(n)) {
      lowest = n;
    }
  }
  if (lowest == 0) {
    return std::nullopt;
  }
  // The highest: double while accepted, then halve the gap between the last
  // accepted count and the first rejected one.
  size_t good = lowest;
  size_t bad = limit + 1;
  for (size_t n = lowest * 2; n <= limit; n *= 2) {
    if (!accepts(n)) {
      bad = n;
      break;
    }
    good = n;
  }
  if (bad == limit + 1 && good < limit) {
    if (accepts(limit)) {
      good = limit;
    } else {
      bad = limit;
    }
  }
  while (bad - good > 1) {
    const size_t mid = good + ((bad - good) / 2);
    if (accepts(mid)) {
      good = mid;
    } else {
      bad = mid;
    }
  }
  return LevelRange{lowest, good};
}

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

  const common_json levels = scoreLevels(decision, model);

  common_json info = common_json::object();
  info["decision_type"] = std::string(decisionTypeName(decision.type));
  info["noul"] = noulSemantics(decision.type);
  info["joint"] = decision.is_joint();
  info["shared_prefix"] = decision.can_share_prompt();
  info["images"] = decision.can_use_images() && meta.has_inp_image;
  info["audio"] = decision.can_use_images() && meta.has_inp_audio;
  info["score_levels"] = levels;
  // What a score answer is: upstream returns the median level for lfm3-d1
  // (and its omni variant), the expected level for the others.
  info["score"] =
      levels.is_null()
          ? common_json(nullptr)
          : common_json(
                decision.is_lfm3_d1() ? "median_level" : "expected_level");
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
  // The path is UTF-8 from JS. A std::string converts with the ANSI code page
  // on Windows, so build the path from UTF-8 text, as llama's file reads do.
  const std::u8string utf8(path.begin(), path.end());
  std::error_code ec;
  if (!std::filesystem::is_regular_file(std::filesystem::path(utf8), ec)) {
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

DecisionContext::DecisionContext(
    const common_params& params, const MediaLimits& media)
    : state_(std::make_unique<State>()) {
  State& d = *state_;
  d.params = params;
  // No HTTP: the server's own request threads and endpoints are never used.
  d.params.endpoint_metrics = false;
  postprocess_cpu_params(d.params.cpuparams, nullptr);
  postprocess_cpu_params(d.params.cpuparams_batch, &d.params.cpuparams);

  checkModelFile(d.params.model.path);

  try {
    // The backends are loaded by whoever holds the backends handle
    // (DecisionEngineModel's LlamaBackendsHandle, from backendsDir or
    // @qvac/fabric's own); loading @qvac/fabric's here as well would register
    // them twice next to a custom backendsDir. llama_backend_init() may run
    // again.
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
    // Media size limits, checked before a file is decoded (fabric's
    // mtmd-helper); set before any request can decode one.
    d.ctx->qvac_set_media_limits(media.maxImagePixels, media.maxAudioSeconds);
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
      failStopped(d, at(where));
    }
    failRequest(at(where) + e.what());
  } catch (const common_json_error& e) {
    // Bad JSON or a value of the wrong type. The runtime holds the only
    // type_info of common_json_error (its destructor is out of line in the
    // port, which the exports function checks is this addon's), so this
    // matches what the runtime throws.
    failIfLoopDead(d, at(where));
    if (stop()) {
      failStopped(d, at(where));
    }
    failRequest(at(where) + e.what());
  } catch (const std::exception& e) {
    failIfLoopDead(d, at(where));
    if (stop()) {
      failStopped(d, at(where));
    }
    fail(DecodeFailed, at(where) + e.what());
  } catch (...) {
    failIfLoopDead(d, at(where));
    if (stop()) {
      failStopped(d, at(where));
    }
    fail(DecodeFailed, at(where) + "unknown error");
  }

  // A cancelled request can come back untouched: status 200 and no data. The
  // stop signal decides, never the status alone; a dead loop comes first, as
  // it raises the stop signal too.
  failIfLoopDead(d, at(where));
  if (stop()) {
    failStopped(d, at(where));
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
    // model without image input), also a property of the request. Upstream's
    // 501 text names llama-server's flag; here the projector is a load option.
    if (res->status == 400 || res->status == 501) {
      std::string text = message;
      const std::string flag = "start it with `--mmproj`";
      if (const size_t at = text.find(flag); at != std::string::npos) {
        text.replace(at, flag.size(), "load it with the `mmproj` option");
      }
      failRequest(at(where) + text);
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

  // The request without "states", serialized once: an object without
  // "state", and empty when the request has nothing else (upstream then
  // rejects each state's request for its missing "questions"). Each worker
  // appends the state it claims and keeps that one body for its run, so a
  // batch holds one copy of the shared inputs (questions, files) plus one body
  // per worker, not one per state, and a stop before a state is claimed
  // serializes nothing more.
  common_json shared = request;
  shared.erase("states");
  const std::string sharedText = shared.dump();
  const bool sharedEmpty = shared.empty();
  const auto bodyFor = [&d, &sharedText, sharedEmpty, &states](size_t i) {
    d.batchBodies.fetch_add(1, std::memory_order_relaxed);
    const std::string state = states[i].dump();
    std::string body;
    body.reserve(sharedText.size() + state.size() + 10);
    body.append(sharedText, 0, sharedText.size() - 1);
    if (!sharedEmpty) {
      body += ',';
    }
    body += "\"state\":";
    body += state;
    body += '}';
    return body;
  };

  const size_t n = states.size();
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
            d, bodyFor(i), batchStop, "states[" + std::to_string(i) + "]");
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
  // Joins the started workers on every exit path: a joinable std::thread
  // destroyed during unwinding calls std::terminate.
  struct JoinAll {
    std::vector<std::thread>& threads;
    explicit JoinAll(std::vector<std::thread>& started) : threads(started) {}
    JoinAll(const JoinAll&) = delete;
    JoinAll& operator=(const JoinAll&) = delete;
    ~JoinAll() {
      for (std::thread& t : threads) {
        if (t.joinable()) {
          t.join();
        }
      }
    }
  } joinAll(threads);
  threads.reserve(workers - 1);
  for (size_t w = 1; w < workers; ++w) {
    try {
      threads.emplace_back(worker);
    } catch (const std::system_error& e) {
      // No more threads: the started workers, and this one, take the
      // remaining states from `next`, so the batch still completes.
      LOG_WRN(
          "decision batch: started %zu of %zu workers: %s\n",
          w,
          workers,
          e.what());
      break;
    }
  }
  worker();
  for (std::thread& t : threads) {
    t.join();
  }

  if (stop()) {
    failStopped(d, "");
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
    failStopped(d, "");
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

size_t DecisionContext::batchBodiesSerializedForTesting() const noexcept {
  return state_->batchBodies.load(std::memory_order_relaxed);
}

void DecisionContext::markLoopDeadForTesting(
    const std::string& error) noexcept {
  State& d = *state_;
  try {
    d.loopError = error;
  } catch (...) {
    d.loopError.clear();
  }
  d.loopDead.store(true, std::memory_order_release);
}

} // namespace qvac_lib_inference_addon_decision
