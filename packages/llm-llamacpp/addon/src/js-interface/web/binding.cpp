// Browser (Emscripten) binding over the same LlamaModel the Bare binding
// drives. The build has no threads, so concurrent jobs use the model's
// continuous-batching scheduler in cooperative mode: one decode quantum runs
// per Asyncify call, then binding.browser.js returns to the worker event loop
// before driving the next quantum. Single-slot models keep the direct path.
// binding.browser.js adapts both paths to the LlamaBinding surface `addon.js`
// expects.
#include <any>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <emscripten.h>
#include <inference-addon-cpp/Errors.hpp>
#include <nlohmann/json.hpp>
#include <qvac-fabric.h>

#include "handlers/GenerationParamHandlers.hpp"
#include "model-interface/LlamaModel.hpp"

using json = nlohmann::json;
using qvac_lib_inference_addon_llama::GenerationParamSource;

// The ggml backends are linked statically and register themselves, so there
// is no backends directory to load from. Bare gets these from @qvac/fabric.
extern "C" size_t qvac_fabric_load_backends(void) { return 0; }
extern "C" const char* qvac_fabric_backends_dir(void) { return ""; }

// Delivers one event to binding.browser.js. A nonzero return asks the running
// job to stop. Pointers arrive as BigInt in the Memory64 build, hence Number().
EM_JS(
    int, qvac_web_emit,
    (int handle, int jobId, const char* event, int eventSize,
     const char* payload, int payloadSize),
    {
      return Module.qvacEmit(
                 handle,
                 jobId,
                 UTF8ToString(Number(event), Number(eventSize), true),
                 UTF8ToString(Number(payload), Number(payloadSize), true))
                 ? 1
                 : 0;
    });

namespace {

using Clock = std::chrono::steady_clock;

// Upper bound on how long a job runs without handing the event loop back, so
// postMessage (cancel) is serviced even when no GPU wait yields for us.
constexpr auto K_YIELD_INTERVAL = std::chrono::milliseconds(30);

std::unordered_map<int, std::unique_ptr<LlamaModel>> instances;
using StagedPromptMedia = std::vector<std::vector<uint8_t>>;
using StagedJobMedia = std::vector<StagedPromptMedia>;
std::unordered_map<int, std::unordered_map<int, StagedJobMedia>> stagedMedia;
struct BrowserJob {
  bool batch = false;
};
std::unordered_map<int, std::unordered_map<int, BrowserJob>> browserJobs;
int nextHandle = 1;
std::string lastResult = "{}";

json errorJson(const std::exception& error) {
  json result{{"error", error.what()}};
  if (const auto* status =
          dynamic_cast<const qvac_errors::StatusError*>(&error)) {
    result["code"] = status->codeString();
  } else {
    result["code"] = "INTERNAL_ERROR";
  }
  return result;
}

int fail(const std::exception& error) {
  lastResult = errorJson(error).dump();
  return -1;
}

LlamaModel& instance(int handle) {
  auto it = instances.find(handle);
  if (it == instances.end() || it->second == nullptr) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Model is not loaded");
  }
  return *it->second;
}

StagedJobMedia takeStagedMedia(int handle, int jobId) {
  auto handleIt = stagedMedia.find(handle);
  if (handleIt == stagedMedia.end())
    return {};
  auto jobIt = handleIt->second.find(jobId);
  if (jobIt == handleIt->second.end())
    return {};
  StagedJobMedia job = std::move(jobIt->second);
  handleIt->second.erase(jobIt);
  if (handleIt->second.empty())
    stagedMedia.erase(handleIt);
  return job;
}

[[noreturn]] void wrongType(const char* key, const char* expected) {
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      std::string("Expected property ") + key + " to be of type " + expected);
}

// Mirrors JsArgsParser::getOptionalProperty: null and absent read as unset,
// any other type mismatch is an InvalidArgument.
GenerationParamSource jsonSource(const json& obj) {
  auto lookup = [&obj](const char* key) -> const json* {
    auto it = obj.find(key);
    return it == obj.end() || it->is_null() ? nullptr : &*it;
  };
  return GenerationParamSource{
      .number = [lookup](const char* key) -> std::optional<double> {
        const json* value = lookup(key);
        if (value == nullptr)
          return std::nullopt;
        if (!value->is_number())
          wrongType(key, "number");
        return value->get<double>();
      },
      .string = [lookup](const char* key) -> std::optional<std::string> {
        const json* value = lookup(key);
        if (value == nullptr)
          return std::nullopt;
        if (!value->is_string())
          wrongType(key, "string");
        return value->get<std::string>();
      },
      .boolean = [lookup](const char* key) -> std::optional<bool> {
        const json* value = lookup(key);
        if (value == nullptr)
          return std::nullopt;
        if (!value->is_boolean())
          wrongType(key, "boolean");
        return value->get<bool>();
      }};
}

// Same rules as parsePromptInputs in AddonJs.hpp; media arrives as a byte
// array because JSON has no binary type.
LlamaModel::Prompt parsePrompt(const json& messages) {
  using qvac_errors::StatusError;
  namespace general_error = qvac_errors::general_error;
  if (!messages.is_array()) {
    throw StatusError(
        general_error::InvalidArgument, "Expected an array of messages");
  }
  LlamaModel::Prompt prompt;
  for (const auto& message : messages) {
    const std::string type = message.value("type", "");
    if (type == "text") {
      if (!prompt.input.empty()) {
        throw StatusError(
            general_error::InvalidArgument, "Only one text input is allowed");
      }
      prompt.input = message.at("input").get<std::string>();
      prompt.prefill = message.value("prefill", false);
      if (auto it = message.find("generationParams");
          it != message.end() && !it->is_null()) {
        if (!it->is_object())
          wrongType("generationParams", "object");
        applyGenerationParamHandlers(jsonSource(*it), prompt.generationParams);
      }
      prompt.cacheKey = message.value("cacheKey", "");
      prompt.ephemeral = message.value("ephemeral", false);
      prompt.baseCacheKey = message.value("baseCacheKey", "");
    } else if (type == "media") {
      prompt.media.push_back(message.at("content").get<std::vector<uint8_t>>());
    } else {
      throw StatusError(
          general_error::InvalidArgument, "Unknown input type: " + type);
    }
  }
  if (prompt.input.empty() && prompt.media.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "At least one of text or media input is required");
  }
  return prompt;
}

json statsJson(const qvac_lib_inference_addon_cpp::RuntimeStats& stats) {
  json out = json::object();
  for (const auto& [key, value] : stats) {
    std::visit([&out, &key](auto number) { out[key] = number; }, value);
  }
  return out;
}

void prependMedia(LlamaModel::Prompt &prompt,
                  StagedPromptMedia &&stagedPromptMedia) {
  prompt.media.insert(prompt.media.begin(),
                      std::make_move_iterator(stagedPromptMedia.begin()),
                      std::make_move_iterator(stagedPromptMedia.end()));
}

std::function<void(const std::string &)>
outputCallback(int handle, int jobId,
               std::optional<std::string> promptId = std::nullopt) {
  return
      [handle, jobId, promptId = std::move(promptId)](const std::string &text) {
        int stop = 0;
        if (promptId.has_value()) {
          const std::string payload = json{
              {"type", "batch_output"},
              {"id", *promptId},
              {"output", text}}.dump();
          stop = qvac_web_emit(handle, jobId, "BatchOutput",
                               sizeof("BatchOutput") - 1, payload.data(),
                               static_cast<int>(payload.size()));
        } else {
          stop = qvac_web_emit(handle, jobId, "Output", sizeof("Output") - 1,
                               text.data(), static_cast<int>(text.size()));
        }
        if (stop != 0) {
          instance(handle).cancelById(
              static_cast<qvac_lib_inference_addon_cpp::JobId>(jobId));
        }
      };
}

void emitError(int handle, int jobId, const std::exception &error) {
  const std::string payload = errorJson(error).dump();
  qvac_web_emit(handle, jobId, "Error", sizeof("Error") - 1, payload.data(),
                static_cast<int>(payload.size()));
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* qvac_web_result() {
  return lastResult.c_str();
}

// Returns a handle (> 0) or -1 with the error in qvac_web_result().
EMSCRIPTEN_KEEPALIVE int qvac_web_create(
    const char* path, const char* projectionPath, const char* config) {
  try {
    std::unordered_map<std::string, std::string> map;
    const json parsed = json::parse(config);
    for (const auto& [key, value] : parsed.items()) {
      // Same contract as the Bare binding's config submap.
      if (!value.is_string())
        wrongType(key.c_str(), "string");
      map[key] = value.get<std::string>();
    }
    auto model = std::make_unique<LlamaModel>(
        std::string(path), std::string(projectionPath), std::move(map));
    const int handle = nextHandle++;
    instances.emplace(handle, std::move(model));
    return handle;
  } catch (const std::exception& error) {
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE int qvac_web_activate(int handle) {
  try {
    instance(handle).waitForLoadInitialization();
    return 0;
  } catch (const std::exception& error) {
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE int qvac_web_stage_media(int handle, int jobId,
                                              int promptIndex, int mediaIndex,
                                              const uint8_t *bytes, int size) {
  try {
    instance(handle);
    if (jobId < 0 || promptIndex < 0 || mediaIndex < 0 || size < 0 ||
        (size > 0 && bytes == nullptr)) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Invalid staged media coordinates or buffer");
    }
    StagedJobMedia &job = stagedMedia[handle][jobId];
    const auto prompt = static_cast<size_t>(promptIndex);
    const auto media = static_cast<size_t>(mediaIndex);
    if (prompt >= job.size())
      job.resize(prompt + 1);
    if (media > job[prompt].size()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Staged media indices must be contiguous");
    }
    if (media == job[prompt].size())
      job[prompt].emplace_back();
    std::vector<uint8_t> &content = job[prompt][media];
    if (size == 0) {
      return 0;
    }
    content.insert(content.end(), bytes, bytes + size);
    return 0;
  } catch (const std::exception &error) {
    stagedMedia[handle].erase(jobId);
    if (stagedMedia[handle].empty())
      stagedMedia.erase(handle);
    return fail(error);
  }
}

// Runs one job to completion, streaming `Output` events and ending with a
// `JobEnded` (runtime stats) or `Error` event, all tagged with @p jobId.
EMSCRIPTEN_KEEPALIVE int
qvac_web_run(int handle, int jobId, const char* messages) {
  try {
    LlamaModel& model = instance(handle);
    StagedJobMedia media = takeStagedMedia(handle, jobId);
    LlamaModel::Prompt prompt = parsePrompt(json::parse(messages));
    if (media.size() > 1) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Staged media contains an unknown prompt index");
    }
    if (!media.empty())
      prependMedia(prompt, std::move(media.front()));
    auto lastYield = Clock::now();
    prompt.outputCallback =
        [&model, handle, jobId, &lastYield](const std::string& text) {
          bool stop = qvac_web_emit(
                          handle,
                          jobId,
                          "Output",
                          sizeof("Output") - 1,
                          text.data(),
                          static_cast<int>(text.size())) != 0;
          if (!stop && Clock::now() - lastYield >= K_YIELD_INTERVAL) {
            emscripten_sleep(0);
            lastYield = Clock::now();
            stop = qvac_web_emit(
                       handle, jobId, "Poll", sizeof("Poll") - 1, "", 0) != 0;
          }
          if (stop)
            model.cancel();
        };
    model.process(std::any(std::move(prompt)));
    const std::string payload = statsJson(model.runtimeStats()).dump();
    qvac_web_emit(
        handle,
        jobId,
        "JobEnded",
        sizeof("JobEnded") - 1,
        payload.data(),
        static_cast<int>(payload.size()));
    return 0;
  } catch (const std::exception& error) {
    const std::string payload = errorJson(error).dump();
    qvac_web_emit(
        handle,
        jobId,
        "Error",
        sizeof("Error") - 1,
        payload.data(),
        static_cast<int>(payload.size()));
    return fail(error);
  }
}

// Admits one prompt or one explicit prompt batch without running inference.
// qvac_web_step() later advances every admitted group through the shared
// continuous-batching scheduler one decode quantum at a time.
EMSCRIPTEN_KEEPALIVE int qvac_web_submit(int handle, int jobId, int isBatch,
                                         const char *data) {
  try {
    if (jobId <= 0) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Cooperative inference requires a positive job id");
    }
    LlamaModel &model = instance(handle);
    if (!model.supportsBatching()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Concurrent browser inference requires parallel >= 2");
    }

    StagedJobMedia media = takeStagedMedia(handle, jobId);
    const json parsed = json::parse(data);
    std::vector<LlamaModel::Prompt> prompts;
    BrowserJob job;
    job.batch = isBatch != 0;
    if (job.batch) {
      if (!parsed.is_array() || parsed.empty()) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            "Batch input must be a non-empty array");
      }
      prompts.reserve(parsed.size());
      for (size_t index = 0; index < parsed.size(); ++index) {
        const json &item = parsed[index];
        if (!item.is_object() || !item.contains("messages") ||
            !item.contains("id") || !item["id"].is_string()) {
          throw qvac_errors::StatusError(
              qvac_errors::general_error::InvalidArgument,
              "Each batch item requires a string id and messages array");
        }
        std::string promptId = item["id"].get<std::string>();
        LlamaModel::Prompt prompt = parsePrompt(item["messages"]);
        if (index < media.size())
          prependMedia(prompt, std::move(media[index]));
        prompt.outputCallback = outputCallback(handle, jobId, promptId);
        prompts.push_back(std::move(prompt));
      }
    } else {
      LlamaModel::Prompt prompt = parsePrompt(parsed);
      if (!media.empty())
        prependMedia(prompt, std::move(media.front()));
      prompt.outputCallback = outputCallback(handle, jobId);
      prompts.push_back(std::move(prompt));
    }
    if (media.size() > prompts.size()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Staged media contains an unknown prompt index");
    }

    auto &jobs = browserJobs[handle];
    if (!jobs.emplace(jobId, std::move(job)).second) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Duplicate live browser job id");
    }
    try {
      model.submitCooperative(
          prompts, static_cast<qvac_lib_inference_addon_cpp::JobId>(jobId));
    } catch (...) {
      jobs.erase(jobId);
      if (jobs.empty())
        browserJobs.erase(handle);
      throw;
    }
    return 0;
  } catch (const std::exception &error) {
    stagedMedia[handle].erase(jobId);
    if (stagedMedia[handle].empty())
      stagedMedia.erase(handle);
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE int qvac_web_step(int handle) {
  LlamaModel *model = nullptr;
  try {
    model = &instance(handle);
    (void)model->stepCooperative();

    auto handleIt = browserJobs.find(handle);
    if (handleIt == browserJobs.end())
      return 0;
    std::vector<int> ids;
    ids.reserve(handleIt->second.size());
    for (const auto &[id, unused] : handleIt->second) {
      (void)unused;
      ids.push_back(id);
    }
    for (const int id : ids) {
      auto jobIt = handleIt->second.find(id);
      if (jobIt == handleIt->second.end())
        continue;
      try {
        auto result = model->takeCooperative(
            static_cast<qvac_lib_inference_addon_cpp::JobId>(id));
        if (!result.has_value())
          continue;
        if (jobIt->second.batch) {
          const std::string payload = json(*result).dump();
          qvac_web_emit(handle, id, "BatchResult", sizeof("BatchResult") - 1,
                        payload.data(), static_cast<int>(payload.size()));
        }
        const std::string stats =
            statsJson(model->consumeJobStats(
                          static_cast<qvac_lib_inference_addon_cpp::JobId>(id)))
                .dump();
        qvac_web_emit(handle, id, "JobEnded", sizeof("JobEnded") - 1,
                      stats.data(), static_cast<int>(stats.size()));
        handleIt->second.erase(jobIt);
      } catch (const std::exception &error) {
        emitError(handle, id, error);
        handleIt->second.erase(jobIt);
      }
    }
    if (handleIt->second.empty()) {
      browserJobs.erase(handleIt);
      return 0;
    }
    return 1;
  } catch (const std::exception &error) {
    auto jobs = browserJobs.find(handle);
    if (model != nullptr && jobs != browserJobs.end()) {
      std::vector<int> ids;
      ids.reserve(jobs->second.size());
      for (const auto &[id, unused] : jobs->second) {
        (void)unused;
        ids.push_back(id);
        model->cancelById(static_cast<qvac_lib_inference_addon_cpp::JobId>(id));
      }
      try {
        while (model->stepCooperative()) {
        }
      } catch (...) {
      }
      for (const int id : ids) {
        try {
          (void)model->takeCooperative(
              static_cast<qvac_lib_inference_addon_cpp::JobId>(id));
        } catch (...) {
        }
        emitError(handle, id, error);
      }
      browserJobs.erase(jobs);
    }
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE int qvac_web_cancel_job(int handle, int jobId) {
  try {
    instance(handle).cancelById(
        static_cast<qvac_lib_inference_addon_cpp::JobId>(jobId));
    return 0;
  } catch (const std::exception &error) {
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE int qvac_web_active_slots(int handle) {
  try {
    return static_cast<int>(instance(handle).activeSlots());
  } catch (const std::exception &error) {
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE int qvac_web_save_cache(int handle, const char* cacheKey) {
  try {
    instance(handle).saveCache(cacheKey);
    return 0;
  } catch (const std::exception& error) {
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE int
qvac_web_discard_cache(int handle, const char* cacheKey) {
  try {
    instance(handle).discardCache(cacheKey);
    return 0;
  } catch (const std::exception& error) {
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE double
qvac_web_calc_tokens(int handle, const char* params) {
  try {
    const json parsed = json::parse(params);
    if (!parsed.is_object())
      wrongType("params", "object");
    const auto optionalString = [&parsed](const char* key) {
      const auto it = parsed.find(key);
      if (it == parsed.end() || it->is_null())
        return std::optional<std::string>{};
      if (!it->is_string())
        wrongType(key, "string");
      return std::optional<std::string>{it->get<std::string>()};
    };
    const LlamaModel::CalcTokensRequest request{
        .text = optionalString("text"),
        .history = optionalString("history"),
        .tools = optionalString("tools")};
    return static_cast<double>(instance(handle).calcTokens(request));
  } catch (const std::exception& error) {
    return fail(error);
  }
}

EMSCRIPTEN_KEEPALIVE int qvac_web_destroy(int handle) {
  try {
    if (auto jobs = browserJobs.find(handle);
        jobs != browserJobs.end() && !jobs->second.empty()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Cannot destroy a model with live browser jobs");
    }
    stagedMedia.erase(handle);
    browserJobs.erase(handle);
    instances.erase(handle);
    return 0;
  } catch (const std::exception &error) {
    return fail(error);
  }
}
}
