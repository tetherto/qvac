#include <bare.h>

#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <qvac-onnx/OnnxRuntime.hpp>
#include <qvac-onnx/OnnxSession.hpp>

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define JSCHECK(call)                                                          \
  if ((call) != 0) throw std::runtime_error("js API call failed")

#define CATCH                                                                  \
  catch (const std::exception& e) {                                            \
    js_throw_error(env, "QVAC_ONNX_ERROR", e.what());                         \
    return nullptr;                                                            \
  }                                                                            \
  catch (...) {                                                                \
    js_throw_error(env, "QVAC_ONNX_ERROR", "Unknown error");                  \
    return nullptr;                                                            \
  }
// NOLINTEND(cppcoreguidelines-macro-usage)

namespace {

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

std::mutex sessionsMtx;
std::unordered_map<uint64_t, std::unique_ptr<onnx_addon::OnnxSession>> sessions;
uint64_t nextSessionId = 0;

// ---------------------------------------------------------------------------
// JS helpers (thin wrappers over js.h)
// ---------------------------------------------------------------------------

std::vector<js_value_t*> getArgs(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 0;
  JSCHECK(js_get_callback_info(env, info, &argc, nullptr, nullptr, nullptr));
  std::vector<js_value_t*> args(argc);
  JSCHECK(js_get_callback_info(env, info, &argc, args.data(), nullptr,
                                nullptr));
  return args;
}

js_value_t* jsString(js_env_t* env, std::string_view str) {
  js_value_t* result = nullptr;
  JSCHECK(js_create_string_utf8(env, reinterpret_cast<const utf8_t*>(str.data()),
                                 str.size(), &result));
  return result;
}

std::string fromJsString(js_env_t* env, js_value_t* value) {
  size_t len = 0;
  JSCHECK(js_get_value_string_utf8(env, value, nullptr, 0, &len));
  std::string result(len, '\0');
  JSCHECK(js_get_value_string_utf8(
      env, value, reinterpret_cast<utf8_t*>(result.data()), len, nullptr));
  return result;
}

js_value_t* jsNumber(js_env_t* env, int64_t val) {
  js_value_t* result = nullptr;
  JSCHECK(js_create_int64(env, val, &result));
  return result;
}

int32_t fromJsInt32(js_env_t* env, js_value_t* value) {
  int32_t result = 0;
  JSCHECK(js_get_value_int32(env, value, &result));
  return result;
}

int64_t fromJsInt64(js_env_t* env, js_value_t* value) {
  int64_t result = 0;
  JSCHECK(js_get_value_int64(env, value, &result));
  return result;
}

js_value_t* jsObject(js_env_t* env) {
  js_value_t* result = nullptr;
  JSCHECK(js_create_object(env, &result));
  return result;
}

void jsPropSet(js_env_t* env, js_value_t* obj, const char* key,
               js_value_t* val) {
  JSCHECK(js_set_named_property(env, obj, key, val));
}

js_value_t* jsPropGet(js_env_t* env, js_value_t* obj, const char* key) {
  js_value_t* result = nullptr;
  JSCHECK(js_get_named_property(env, obj, key, &result));
  return result;
}

bool jsIsUndefinedOrNull(js_env_t* env, js_value_t* value) {
  bool undef = false;
  bool null = false;
  JSCHECK(js_is_undefined(env, value, &undef));
  JSCHECK(js_is_null(env, value, &null));
  return undef || null;
}

bool jsIsObject(js_env_t* env, js_value_t* value) {
  bool result = false;
  JSCHECK(js_is_object(env, value, &result));
  return result;
}

js_value_t* jsArray(js_env_t* env, size_t len) {
  js_value_t* result = nullptr;
  JSCHECK(js_create_array_with_length(env, len, &result));
  return result;
}

uint32_t jsArrayLen(js_env_t* env, js_value_t* arr) {
  uint32_t result = 0;
  JSCHECK(js_get_array_length(env, arr, &result));
  return result;
}

js_value_t* jsArrayGet(js_env_t* env, js_value_t* arr, uint32_t index) {
  js_value_t* result = nullptr;
  JSCHECK(js_get_element(env, arr, index, &result));
  return result;
}

void jsArraySet(js_env_t* env, js_value_t* arr, uint32_t index,
                js_value_t* val) {
  JSCHECK(js_set_element(env, arr, index, val));
}

/// Get optional string property from a JS object. Returns empty optional
/// if the property is undefined/null.
std::optional<std::string> jsOptString(js_env_t* env, js_value_t* obj,
                                       const char* key) {
  auto* val = jsPropGet(env, obj, key);
  if (jsIsUndefinedOrNull(env, val)) return std::nullopt;
  return fromJsString(env, val);
}

/// Get optional int32 property from a JS object.
std::optional<int32_t> jsOptInt32(js_env_t* env, js_value_t* obj,
                                  const char* key) {
  auto* val = jsPropGet(env, obj, key);
  if (jsIsUndefinedOrNull(env, val)) return std::nullopt;
  return fromJsInt32(env, val);
}

/// Get optional bool property from a JS object.
std::optional<bool> jsOptBool(js_env_t* env, js_value_t* obj,
                              const char* key) {
  auto* val = jsPropGet(env, obj, key);
  if (jsIsUndefinedOrNull(env, val)) return std::nullopt;
  bool result = false;
  JSCHECK(js_get_value_bool(env, val, &result));
  return result;
}

/// Create a JS TypedArray by copying data from a span.
template <typename T>
js_value_t* jsTypedArray(js_env_t* env, const T* data, size_t count) {
  constexpr js_typedarray_type_t arrayType = [] {
    if constexpr (std::is_same_v<T, float>) return js_float32array;
    else if constexpr (std::is_same_v<T, int64_t>) return js_bigint64array;
    else if constexpr (std::is_same_v<T, int32_t>) return js_int32array;
    else if constexpr (std::is_same_v<T, int8_t>) return js_int8array;
    else if constexpr (std::is_same_v<T, uint8_t>) return js_uint8array;
    else if constexpr (std::is_same_v<T, double>) return js_float64array;
    else { static_assert(sizeof(T) == 0, "Unsupported typed array type"); }
  }();

  size_t byteLen = count * sizeof(T);
  js_value_t* arrayBuffer = nullptr;
  void* bufferData = nullptr;
  JSCHECK(js_create_arraybuffer(env, byteLen, &bufferData, &arrayBuffer));
  std::memcpy(bufferData, data, byteLen);

  js_value_t* typedArray = nullptr;
  JSCHECK(js_create_typedarray(env, arrayType, count, arrayBuffer, 0,
                                &typedArray));
  return typedArray;
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

onnx_addon::OnnxSession& getSession(js_env_t* env, js_value_t* handle) {
  auto id = static_cast<uint64_t>(fromJsInt64(env, handle));
  std::scoped_lock lock{sessionsMtx};
  auto found = sessions.find(id);
  if (found == sessions.end()) {
    throw std::invalid_argument("Invalid session handle");
  }
  return *found->second;
}

std::string tensorTypeToString(onnx_addon::TensorType type) {
  switch (type) {
    case onnx_addon::TensorType::FLOAT32: return "float32";
    case onnx_addon::TensorType::FLOAT16: return "float16";
    case onnx_addon::TensorType::INT64:   return "int64";
    case onnx_addon::TensorType::INT32:   return "int32";
    case onnx_addon::TensorType::INT8:    return "int8";
    case onnx_addon::TensorType::UINT8:   return "uint8";
    default: return "unknown";
  }
}

onnx_addon::TensorType stringToTensorType(std::string_view str) {
  if (str == "float32") return onnx_addon::TensorType::FLOAT32;
  if (str == "float16") return onnx_addon::TensorType::FLOAT16;
  if (str == "int64")   return onnx_addon::TensorType::INT64;
  if (str == "int32")   return onnx_addon::TensorType::INT32;
  if (str == "int8")    return onnx_addon::TensorType::INT8;
  if (str == "uint8")   return onnx_addon::TensorType::UINT8;
  return onnx_addon::TensorType::FLOAT32;
}

onnx_addon::ExecutionProvider stringToProvider(std::string_view str) {
  if (str == "cpu")       return onnx_addon::ExecutionProvider::CPU;
  if (str == "auto_gpu")  return onnx_addon::ExecutionProvider::AUTO_GPU;
  if (str == "nnapi")     return onnx_addon::ExecutionProvider::NNAPI;
  if (str == "coreml")    return onnx_addon::ExecutionProvider::CoreML;
  if (str == "directml")  return onnx_addon::ExecutionProvider::DirectML;
  return onnx_addon::ExecutionProvider::AUTO_GPU;
}

onnx_addon::GraphOptimizationLevel stringToOptimization(
    std::string_view str) {
  if (str == "disable")  return onnx_addon::GraphOptimizationLevel::DISABLE;
  if (str == "basic")    return onnx_addon::GraphOptimizationLevel::BASIC;
  if (str == "extended") return onnx_addon::GraphOptimizationLevel::EXTENDED;
  if (str == "all")      return onnx_addon::GraphOptimizationLevel::ALL;
  return onnx_addon::GraphOptimizationLevel::EXTENDED;
}

onnx_addon::LoggingLevel stringToLoggingLevel(std::string_view str) {
  if (str == "verbose") return onnx_addon::LoggingLevel::VERBOSE;
  if (str == "info")    return onnx_addon::LoggingLevel::INFO;
  if (str == "warning") return onnx_addon::LoggingLevel::WARNING;
  if (str == "error")   return onnx_addon::LoggingLevel::ERROR;
  if (str == "fatal")   return onnx_addon::LoggingLevel::FATAL;
  return onnx_addon::LoggingLevel::WARNING;
}

onnx_addon::ExecutionMode stringToExecutionMode(std::string_view str) {
  if (str == "parallel") return onnx_addon::ExecutionMode::PARALLEL;
  return onnx_addon::ExecutionMode::SEQUENTIAL;
}

js_value_t* buildTensorInfoArray(
    js_env_t* env, const std::vector<onnx_addon::TensorInfo>& infos) {
  auto* arr = jsArray(env, infos.size());
  for (uint32_t i = 0; i < infos.size(); ++i) {
    auto* obj = jsObject(env);
    jsPropSet(env, obj, "name", jsString(env, infos[i].name));
    jsPropSet(env, obj, "type",
              jsString(env, tensorTypeToString(infos[i].type)));

    auto* shape = jsArray(env, infos[i].shape.size());
    for (uint32_t j = 0; j < infos[i].shape.size(); ++j) {
      jsArraySet(env, shape, j, jsNumber(env, infos[i].shape[j]));
    }
    jsPropSet(env, obj, "shape", shape);

    jsArraySet(env, arr, i, obj);
  }
  return arr;
}

js_value_t* buildOutputTypedArray(js_env_t* env,
                                  const onnx_addon::OutputTensor& output) {
  size_t count = output.elementCount();
  switch (output.type) {
    case onnx_addon::TensorType::FLOAT32:
      return jsTypedArray(env, output.as<float>(), count);
    case onnx_addon::TensorType::INT64:
      return jsTypedArray(env, output.as<int64_t>(), count);
    case onnx_addon::TensorType::INT32:
      return jsTypedArray(env, output.as<int32_t>(), count);
    case onnx_addon::TensorType::INT8:
      return jsTypedArray(env, output.as<int8_t>(), count);
    case onnx_addon::TensorType::UINT8:
      return jsTypedArray(env, output.data.data(), count);
    default:
      return jsTypedArray(env, output.as<float>(), count);
  }
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

auto configureEnvironment(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  auto args = getArgs(env, info);
  onnx_addon::EnvironmentConfig cfg{};

  if (!args.empty() && jsIsObject(env, args[0]) &&
      !jsIsUndefinedOrNull(env, args[0])) {
    auto* configObj = args[0];

    auto level = jsOptString(env, configObj, "loggingLevel");
    if (level) cfg.loggingLevel = stringToLoggingLevel(*level);

    auto id = jsOptString(env, configObj, "loggingId");
    if (id) cfg.loggingId = *id;
  }

  onnx_addon::OnnxRuntime::configure(cfg);
  return nullptr;
}
CATCH

auto getAvailableProviders(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  (void)info;
  auto providers = onnx_addon::OnnxRuntime::getAvailableProviders();
  auto* arr = jsArray(env, providers.size());
  for (uint32_t i = 0; i < providers.size(); ++i) {
    jsArraySet(env, arr, i, jsString(env, providers[i]));
  }
  return arr;
}
CATCH

auto createSession(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  auto args = getArgs(env, info);
  if (args.empty()) {
    throw std::invalid_argument("Expected at least 1 argument: modelPath");
  }

  auto modelPath = fromJsString(env, args[0]);
  onnx_addon::SessionConfig config{};

  // Parse optional config object
  if (args.size() > 1 && jsIsObject(env, args[1]) &&
      !jsIsUndefinedOrNull(env, args[1])) {
    auto* configObj = args[1];

    auto provider = jsOptString(env, configObj, "provider");
    if (provider) config.provider = stringToProvider(*provider);

    auto optimization = jsOptString(env, configObj, "optimization");
    if (optimization) config.optimization = stringToOptimization(*optimization);

    auto intraOp = jsOptInt32(env, configObj, "intraOpThreads");
    if (intraOp) config.intraOpThreads = *intraOp;

    auto interOp = jsOptInt32(env, configObj, "interOpThreads");
    if (interOp) config.interOpThreads = *interOp;

    auto xnnpack = jsOptBool(env, configObj, "enableXnnpack");
    if (xnnpack) config.enableXnnpack = *xnnpack;

    auto memPattern = jsOptBool(env, configObj, "enableMemoryPattern");
    if (memPattern) config.enableMemoryPattern = *memPattern;

    auto cpuMemArena = jsOptBool(env, configObj, "enableCpuMemArena");
    if (cpuMemArena) config.enableCpuMemArena = *cpuMemArena;

    auto execMode = jsOptString(env, configObj, "executionMode");
    if (execMode) config.executionMode = stringToExecutionMode(*execMode);
  }

  auto session =
      std::make_unique<onnx_addon::OnnxSession>(modelPath, config);

  std::scoped_lock lock{sessionsMtx};
  auto id = nextSessionId++;
  sessions.emplace(id, std::move(session));
  return jsNumber(env, static_cast<int64_t>(id));
}
CATCH

auto getInputInfo(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  auto args = getArgs(env, info);
  if (args.empty()) {
    throw std::invalid_argument("Expected 1 argument: session handle");
  }
  auto& session = getSession(env, args[0]);
  return buildTensorInfoArray(env, session.getInputInfo());
}
CATCH

auto getOutputInfo(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  auto args = getArgs(env, info);
  if (args.empty()) {
    throw std::invalid_argument("Expected 1 argument: session handle");
  }
  auto& session = getSession(env, args[0]);
  return buildTensorInfoArray(env, session.getOutputInfo());
}
CATCH

auto run(js_env_t* env, js_callback_info_t* info) -> js_value_t* try {
  auto args = getArgs(env, info);
  if (args.size() < 2) {
    throw std::invalid_argument(
        "Expected 2 arguments: session handle, inputs array");
  }

  auto& session = getSession(env, args[0]);
  auto* inputsArr = args[1];
  uint32_t inputCount = jsArrayLen(env, inputsArr);

  std::vector<onnx_addon::InputTensor> inputs;
  inputs.reserve(inputCount);

  for (uint32_t i = 0; i < inputCount; ++i) {
    auto* inputObj = jsArrayGet(env, inputsArr, i);

    onnx_addon::InputTensor input;
    input.name = fromJsString(env, jsPropGet(env, inputObj, "name"));

    auto typeStr = fromJsString(env, jsPropGet(env, inputObj, "type"));
    input.type = stringToTensorType(typeStr);

    auto* shapeArr = jsPropGet(env, inputObj, "shape");
    uint32_t shapeLen = jsArrayLen(env, shapeArr);
    input.shape.reserve(shapeLen);
    for (uint32_t j = 0; j < shapeLen; ++j) {
      input.shape.push_back(fromJsInt64(env, jsArrayGet(env, shapeArr, j)));
    }

    // Extract raw data pointer from TypedArray
    auto* dataValue = jsPropGet(env, inputObj, "data");
    void* dataPtr = nullptr;
    size_t dataLen = 0;
    JSCHECK(js_get_typedarray_info(env, dataValue, nullptr, &dataPtr, &dataLen,
                                    nullptr, nullptr));
    input.data = dataPtr;
    input.dataSize = dataLen * onnx_addon::tensorTypeSize(input.type);

    inputs.push_back(std::move(input));
  }

  auto outputs = session.run(inputs);

  auto* outputArr = jsArray(env, outputs.size());
  for (uint32_t i = 0; i < outputs.size(); ++i) {
    auto* obj = jsObject(env);
    jsPropSet(env, obj, "name", jsString(env, outputs[i].name));
    jsPropSet(env, obj, "type",
              jsString(env, tensorTypeToString(outputs[i].type)));

    auto* shape = jsArray(env, outputs[i].shape.size());
    for (uint32_t j = 0; j < outputs[i].shape.size(); ++j) {
      jsArraySet(env, shape, j, jsNumber(env, outputs[i].shape[j]));
    }
    jsPropSet(env, obj, "shape", shape);
    jsPropSet(env, obj, "data", buildOutputTypedArray(env, outputs[i]));

    jsArraySet(env, outputArr, i, obj);
  }

  return outputArr;
}
CATCH

auto destroySession(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  auto args = getArgs(env, info);
  if (args.empty()) {
    throw std::invalid_argument("Expected 1 argument: session handle");
  }

  auto id = static_cast<uint64_t>(fromJsInt64(env, args[0]));
  std::scoped_lock lock{sessionsMtx};
  if (sessions.erase(id) == 0) {
    throw std::invalid_argument("Invalid session handle");
  }
  return nullptr;
}
CATCH

}  // namespace

js_value_t* qvacOnnxExports(js_env_t* env, js_value_t* exports) {
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn)                                                   \
  {                                                                   \
    js_value_t* val;                                                  \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {  \
      return nullptr;                                                 \
    }                                                                 \
    if (js_set_named_property(env, exports, name, val) != 0) {        \
      return nullptr;                                                 \
    }                                                                 \
  }

  V("configureEnvironment", configureEnvironment)
  V("getAvailableProviders", getAvailableProviders)
  V("createSession", createSession)
  V("getInputInfo", getInputInfo)
  V("getOutputInfo", getOutputInfo)
  V("run", run)
  V("destroySession", destroySession)
#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(qvac_onnx, qvacOnnxExports)
