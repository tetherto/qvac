// Browser (Emscripten) binding over the same LlamaModel the Bare binding
// drives. The build has no threads, so there is no job scheduler: a job runs
// on the caller's stack and Asyncify suspends it whenever WebGPU awaits the
// GPU (or the token callback yields), which keeps the worker responsive to
// cancel requests. binding.browser.js adapts these exports to the
// LlamaBinding surface `addon.js` expects.
#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>

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
// job to stop.
EM_JS(
    int, qvac_web_emit,
    (int handle, int jobId, const char* event, const char* payload), {
      return Module.qvacEmit(
                 handle, jobId, UTF8ToString(event), UTF8ToString(payload))
                 ? 1
                 : 0;
    });

namespace {

using Clock = std::chrono::steady_clock;

// Upper bound on how long a job runs without handing the event loop back, so
// postMessage (cancel) is serviced even when no GPU wait yields for us.
constexpr auto K_YIELD_INTERVAL = std::chrono::milliseconds(30);

std::unordered_map<int, std::unique_ptr<LlamaModel>> instances;
int nextHandle = 1;
std::string lastResult = "{}";

int fail(const std::exception& error) {
  lastResult = json({{"error", error.what()}}).dump();
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

// Runs one job to completion, streaming `Output` events and ending with a
// `JobEnded` (runtime stats) or `Error` event, all tagged with @p jobId.
EMSCRIPTEN_KEEPALIVE int
qvac_web_run(int handle, int jobId, const char* messages) {
  try {
    LlamaModel& model = instance(handle);
    LlamaModel::Prompt prompt = parsePrompt(json::parse(messages));
    auto lastYield = Clock::now();
    prompt.outputCallback =
        [&model, handle, jobId, &lastYield](const std::string& text) {
          bool stop = qvac_web_emit(handle, jobId, "Output", text.c_str()) != 0;
          if (!stop && Clock::now() - lastYield >= K_YIELD_INTERVAL) {
            emscripten_sleep(0);
            lastYield = Clock::now();
            stop = qvac_web_emit(handle, jobId, "Poll", "") != 0;
          }
          if (stop)
            model.cancel();
        };
    model.process(std::any(std::move(prompt)));
    qvac_web_emit(
        handle,
        jobId,
        "JobEnded",
        statsJson(model.runtimeStats()).dump().c_str());
    return 0;
  } catch (const std::exception& error) {
    qvac_web_emit(handle, jobId, "Error", error.what());
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

EMSCRIPTEN_KEEPALIVE int qvac_web_destroy(int handle) {
  instances.erase(handle);
  return 0;
}
}
