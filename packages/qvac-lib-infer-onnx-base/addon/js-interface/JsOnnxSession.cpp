#include "JsOnnxSession.hpp"

#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace onnx_addon {
namespace js {

namespace {

// Session cache entry with reference count
struct CachedSession {
  OnnxSession* session;
  int refCount;
};

// Global session cache and mutex
std::unordered_map<std::string, CachedSession> g_sessionCache;
std::mutex g_cacheMutex;

// Generate cache key from model path and config
std::string makeCacheKey(const std::string& modelPath, const SessionConfig& config) {
  // Create a unique key from all config parameters
  return modelPath +
         "|p=" + std::to_string(static_cast<int>(config.provider)) +
         "|o=" + std::to_string(static_cast<int>(config.optimization)) +
         "|intra=" + std::to_string(config.intraOpThreads) +
         "|inter=" + std::to_string(config.interOpThreads) +
         "|mem=" + std::to_string(config.enableMemoryPattern) +
         "|arena=" + std::to_string(config.enableCpuMemArena);
}

// Find session in cache by pointer (for destructor)
std::string findCacheKeyBySession(OnnxSession* session) {
  for (const auto& [key, entry] : g_sessionCache) {
    if (entry.session == session) {
      return key;
    }
  }
  return "";
}

// Helper to get string from JS value
std::string getStringArg(js_env_t* env, js_value_t* value) {
  size_t length = 0;
  js_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::vector<utf8_t> buffer(length + 1);
  js_get_value_string_utf8(env, value, buffer.data(), length + 1, nullptr);
  return std::string(reinterpret_cast<const char*>(buffer.data()), length);
}

// Helper to get int from JS value
int32_t getIntArg(js_env_t* env, js_value_t* value) {
  int32_t result = 0;
  js_get_value_int32(env, value, &result);
  return result;
}

// Helper to get double from JS value
double getDoubleArg(js_env_t* env, js_value_t* value) {
  double result = 0.0;
  js_get_value_double(env, value, &result);
  return result;
}

// Helper to get bool from JS value
bool getBoolArg(js_env_t* env, js_value_t* value) {
  bool result = false;
  js_get_value_bool(env, value, &result);
  return result;
}

// Helper to check if property exists
bool hasProperty(js_env_t* env, js_value_t* obj, const char* name) {
  bool result = false;
  js_has_named_property(env, obj, name, &result);
  return result;
}

// Helper to get named property
js_value_t* getProperty(js_env_t* env, js_value_t* obj, const char* name) {
  js_value_t* value = nullptr;
  js_get_named_property(env, obj, name, &value);
  return value;
}

// Helper to create JS string
js_value_t* createString(js_env_t* env, const std::string& str) {
  js_value_t* value = nullptr;
  js_create_string_utf8(env, reinterpret_cast<const utf8_t*>(str.c_str()),
                        str.length(), &value);
  return value;
}

// Helper to create JS number (int)
js_value_t* createInt(js_env_t* env, int32_t num) {
  js_value_t* value = nullptr;
  js_create_int32(env, num, &value);
  return value;
}

// Helper to create JS number (int64)
js_value_t* createInt64(js_env_t* env, int64_t num) {
  js_value_t* value = nullptr;
  js_create_int64(env, num, &value);
  return value;
}

// Convert TensorType to string
const char* tensorTypeToString(TensorType type) {
  switch (type) {
    case TensorType::FLOAT32:
      return "float32";
    case TensorType::FLOAT16:
      return "float16";
    case TensorType::INT64:
      return "int64";
    case TensorType::INT32:
      return "int32";
    case TensorType::INT8:
      return "int8";
    case TensorType::UINT8:
      return "uint8";
    default:
      return "float32";
  }
}

// Convert string to TensorType
TensorType stringToTensorType(const std::string& str) {
  if (str == "float32")
    return TensorType::FLOAT32;
  if (str == "float16")
    return TensorType::FLOAT16;
  if (str == "int64")
    return TensorType::INT64;
  if (str == "int32")
    return TensorType::INT32;
  if (str == "int8")
    return TensorType::INT8;
  if (str == "uint8")
    return TensorType::UINT8;
  return TensorType::FLOAT32;
}

// Convert ExecutionProvider string to enum
ExecutionProvider stringToProvider(const std::string& str) {
  if (str == "cpu")
    return ExecutionProvider::CPU;
  if (str == "auto_gpu" || str == "auto")
    return ExecutionProvider::AUTO_GPU;
  if (str == "nnapi")
    return ExecutionProvider::NNAPI;
  if (str == "coreml")
    return ExecutionProvider::CoreML;
  if (str == "directml")
    return ExecutionProvider::DirectML;
  return ExecutionProvider::AUTO_GPU;
}

// Convert optimization level string to enum
GraphOptimizationLevel stringToOptimization(const std::string& str) {
  if (str == "disable")
    return GraphOptimizationLevel::DISABLE;
  if (str == "basic")
    return GraphOptimizationLevel::BASIC;
  if (str == "extended")
    return GraphOptimizationLevel::EXTENDED;
  if (str == "all")
    return GraphOptimizationLevel::ALL;
  return GraphOptimizationLevel::EXTENDED;
}

// Parse config object
SessionConfig parseConfig(js_env_t* env, js_value_t* configObj) {
  SessionConfig config;

  if (configObj == nullptr) {
    return config;
  }

  js_value_type_t type;
  js_typeof(env, configObj, &type);
  if (type != js_object) {
    return config;
  }

  if (hasProperty(env, configObj, "provider")) {
    auto providerVal = getProperty(env, configObj, "provider");
    config.provider = stringToProvider(getStringArg(env, providerVal));
  }

  if (hasProperty(env, configObj, "optimization")) {
    auto optVal = getProperty(env, configObj, "optimization");
    config.optimization = stringToOptimization(getStringArg(env, optVal));
  }

  if (hasProperty(env, configObj, "intraOpThreads")) {
    config.intraOpThreads =
        getIntArg(env, getProperty(env, configObj, "intraOpThreads"));
  }

  if (hasProperty(env, configObj, "interOpThreads")) {
    config.interOpThreads =
        getIntArg(env, getProperty(env, configObj, "interOpThreads"));
  }

  if (hasProperty(env, configObj, "enableMemoryPattern")) {
    config.enableMemoryPattern =
        getBoolArg(env, getProperty(env, configObj, "enableMemoryPattern"));
  }

  if (hasProperty(env, configObj, "enableCpuMemArena")) {
    config.enableCpuMemArena =
        getBoolArg(env, getProperty(env, configObj, "enableCpuMemArena"));
  }

  return config;
}

// Destructor callback for external - handles refcounting for cached sessions
void sessionDestructor(js_env_t* /*env*/, void* data, void* /*hint*/) {
  auto* session = static_cast<OnnxSession*>(data);

  std::lock_guard<std::mutex> lock(g_cacheMutex);

  // Find the session in cache
  std::string cacheKey = findCacheKeyBySession(session);

  if (!cacheKey.empty()) {
    // Session is cached - decrement refcount
    auto& entry = g_sessionCache[cacheKey];
    entry.refCount--;

    if (entry.refCount <= 0) {
      // No more references - delete session and remove from cache
      delete session;
      g_sessionCache.erase(cacheKey);
    }
  } else {
    // Not in cache (shouldn't happen, but handle gracefully)
    delete session;
  }
}

// Create TensorInfo JS object
js_value_t* createTensorInfoObject(js_env_t* env, const TensorInfo& info) {
  js_value_t* obj = nullptr;
  js_create_object(env, &obj);

  // Set name
  js_value_t* nameVal = createString(env, info.name);
  js_set_named_property(env, obj, "name", nameVal);

  // Set shape as array
  js_value_t* shapeArr = nullptr;
  js_create_array_with_length(env, info.shape.size(), &shapeArr);
  for (size_t i = 0; i < info.shape.size(); ++i) {
    js_value_t* dimVal = createInt64(env, info.shape[i]);
    js_set_element(env, shapeArr, static_cast<uint32_t>(i), dimVal);
  }
  js_set_named_property(env, obj, "shape", shapeArr);

  // Set type
  js_value_t* typeVal = createString(env, tensorTypeToString(info.type));
  js_set_named_property(env, obj, "type", typeVal);

  return obj;
}

// Get arguments from callback info
std::vector<js_value_t*> getArguments(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 16;
  js_value_t* argv[16];
  js_get_callback_info(env, info, &argc, argv, nullptr, nullptr);

  std::vector<js_value_t*> args(argc);
  for (size_t i = 0; i < argc; ++i) {
    args[i] = argv[i];
  }
  return args;
}

// Throw JS error
js_value_t* throwError(js_env_t* env, const char* message) {
  js_throw_error(env, nullptr, message);
  return nullptr;
}

}  // namespace

js_value_t* createSession(js_env_t* env, js_callback_info_t* info) {
  auto args = getArguments(env, info);
  if (args.empty()) {
    return throwError(env, "createSession requires modelPath argument");
  }

  try {
    // Get model path
    std::string modelPath = getStringArg(env, args[0]);

    // Get optional config
    SessionConfig config;
    if (args.size() > 1) {
      config = parseConfig(env, args[1]);
    }

    // Generate cache key
    std::string cacheKey = makeCacheKey(modelPath, config);

    OnnxSession* session = nullptr;

    {
      std::lock_guard<std::mutex> lock(g_cacheMutex);

      // Check if session already exists in cache
      auto it = g_sessionCache.find(cacheKey);
      if (it != g_sessionCache.end()) {
        // Cache hit - reuse existing session
        session = it->second.session;
        it->second.refCount++;
      } else {
        // Cache miss - create new session
        session = new OnnxSession(modelPath, config);
        g_sessionCache[cacheKey] = CachedSession{session, 1};
      }
    }

    // Wrap as external
    js_value_t* external = nullptr;
    js_create_external(env, session, sessionDestructor, nullptr, &external);

    return external;
  } catch (const std::exception& e) {
    return throwError(env, e.what());
  }
}

js_value_t* destroySession(js_env_t* env, js_callback_info_t* info) {
  auto args = getArguments(env, info);
  if (args.empty()) {
    return throwError(env, "destroySession requires session argument");
  }

  // Don't explicitly delete - the destructor callback (sessionDestructor)
  // will be called when JS garbage collects the external.
  // Calling delete here would cause double-free when GC runs.
  // This function exists for API symmetry with createSession and to allow
  // users to indicate they're done with the session (helps with GC hinting).

  js_value_t* undefined = nullptr;
  js_get_undefined(env, &undefined);
  return undefined;
}

js_value_t* getInputInfo(js_env_t* env, js_callback_info_t* info) {
  auto args = getArguments(env, info);
  if (args.empty()) {
    return throwError(env, "getInputInfo requires session argument");
  }

  try {
    auto* session = unwrapSession(env, args[0]);
    if (session == nullptr) {
      return throwError(env, "Invalid session");
    }

    auto inputInfos = session->getInputInfo();

    // Create array
    js_value_t* arr = nullptr;
    js_create_array_with_length(env, inputInfos.size(), &arr);

    for (size_t i = 0; i < inputInfos.size(); ++i) {
      js_value_t* infoObj = createTensorInfoObject(env, inputInfos[i]);
      js_set_element(env, arr, static_cast<uint32_t>(i), infoObj);
    }

    return arr;
  } catch (const std::exception& e) {
    return throwError(env, e.what());
  }
}

js_value_t* getOutputInfo(js_env_t* env, js_callback_info_t* info) {
  auto args = getArguments(env, info);
  if (args.empty()) {
    return throwError(env, "getOutputInfo requires session argument");
  }

  try {
    auto* session = unwrapSession(env, args[0]);
    if (session == nullptr) {
      return throwError(env, "Invalid session");
    }

    auto outputInfos = session->getOutputInfo();

    // Create array
    js_value_t* arr = nullptr;
    js_create_array_with_length(env, outputInfos.size(), &arr);

    for (size_t i = 0; i < outputInfos.size(); ++i) {
      js_value_t* infoObj = createTensorInfoObject(env, outputInfos[i]);
      js_set_element(env, arr, static_cast<uint32_t>(i), infoObj);
    }

    return arr;
  } catch (const std::exception& e) {
    return throwError(env, e.what());
  }
}

js_value_t* run(js_env_t* env, js_callback_info_t* info) {
  auto args = getArguments(env, info);
  if (args.size() < 2) {
    return throwError(env, "run requires session and inputs arguments");
  }

  try {
    auto* session = unwrapSession(env, args[0]);
    if (session == nullptr) {
      return throwError(env, "Invalid session");
    }

    // Parse inputs array
    js_value_t* inputsArr = args[1];
    uint32_t inputCount = 0;
    js_get_array_length(env, inputsArr, &inputCount);

    std::vector<InputTensor> inputs;
    inputs.reserve(inputCount);

    // Keep references to data vectors to prevent deallocation
    std::vector<std::vector<uint8_t>> dataBuffers;
    dataBuffers.reserve(inputCount);

    for (uint32_t i = 0; i < inputCount; ++i) {
      js_value_t* inputObj = nullptr;
      js_get_element(env, inputsArr, i, &inputObj);

      InputTensor input;

      // Get name
      input.name = getStringArg(env, getProperty(env, inputObj, "name"));

      // Get type
      if (hasProperty(env, inputObj, "type")) {
        input.type = stringToTensorType(
            getStringArg(env, getProperty(env, inputObj, "type")));
      }

      // Get shape
      js_value_t* shapeArr = getProperty(env, inputObj, "shape");
      uint32_t shapeLen = 0;
      js_get_array_length(env, shapeArr, &shapeLen);
      input.shape.resize(shapeLen);
      for (uint32_t j = 0; j < shapeLen; ++j) {
        js_value_t* dimVal = nullptr;
        js_get_element(env, shapeArr, j, &dimVal);
        int64_t dim = 0;
        js_get_value_int64(env, dimVal, &dim);
        input.shape[j] = dim;
      }

      // Get data (TypedArray)
      js_value_t* dataVal = getProperty(env, inputObj, "data");
      void* dataPtr = nullptr;
      size_t dataLength = 0;
      js_typedarray_type_t taType;
      js_value_t* arrayBuffer = nullptr;
      size_t byteOffset = 0;

      js_get_typedarray_info(env, dataVal, &taType, &dataPtr, &dataLength,
                             &arrayBuffer, &byteOffset);

      // Copy data to our buffer (to ensure it stays valid)
      size_t byteLength = dataLength * tensorTypeSize(input.type);
      dataBuffers.emplace_back(byteLength);
      std::memcpy(dataBuffers.back().data(), dataPtr, byteLength);

      input.data = dataBuffers.back().data();
      input.dataSize = byteLength;

      inputs.push_back(std::move(input));
    }

    // Run inference
    auto outputs = session->run(inputs);

    // Create output array
    js_value_t* outputArr = nullptr;
    js_create_array_with_length(env, outputs.size(), &outputArr);

    for (size_t i = 0; i < outputs.size(); ++i) {
      const auto& output = outputs[i];

      js_value_t* outputObj = nullptr;
      js_create_object(env, &outputObj);

      // Set name
      js_set_named_property(env, outputObj, "name",
                            createString(env, output.name));

      // Set type
      js_set_named_property(env, outputObj, "type",
                            createString(env, tensorTypeToString(output.type)));

      // Set shape
      js_value_t* shapeArr = nullptr;
      js_create_array_with_length(env, output.shape.size(), &shapeArr);
      for (size_t j = 0; j < output.shape.size(); ++j) {
        js_set_element(env, shapeArr, static_cast<uint32_t>(j),
                       createInt64(env, output.shape[j]));
      }
      js_set_named_property(env, outputObj, "shape", shapeArr);

      // Set data as TypedArray
      js_value_t* arrayBuffer = nullptr;
      void* bufferData = nullptr;
      js_create_arraybuffer(env, output.data.size(), &bufferData, &arrayBuffer);
      std::memcpy(bufferData, output.data.data(), output.data.size());

      js_value_t* typedArray = nullptr;
      js_typedarray_type_t taType = js_float32array;
      size_t elementCount = output.elementCount();

      switch (output.type) {
        case TensorType::FLOAT32:
          taType = js_float32array;
          break;
        case TensorType::INT32:
          taType = js_int32array;
          break;
        case TensorType::INT8:
          taType = js_int8array;
          break;
        case TensorType::UINT8:
          taType = js_uint8array;
          break;
        case TensorType::INT64:
          taType = js_bigint64array;
          break;
        default:
          taType = js_float32array;
          break;
      }

      js_create_typedarray(env, taType, elementCount, arrayBuffer, 0,
                           &typedArray);
      js_set_named_property(env, outputObj, "data", typedArray);

      js_set_element(env, outputArr, static_cast<uint32_t>(i), outputObj);
    }

    return outputArr;
  } catch (const std::exception& e) {
    return throwError(env, e.what());
  }
}

js_value_t* getCacheStats(js_env_t* env, js_callback_info_t* /*info*/) {
  std::lock_guard<std::mutex> lock(g_cacheMutex);

  js_value_t* result = nullptr;
  js_create_object(env, &result);

  // Total sessions in cache
  js_value_t* countVal = nullptr;
  js_create_int32(env, static_cast<int32_t>(g_sessionCache.size()), &countVal);
  js_set_named_property(env, result, "sessionCount", countVal);

  // Array of session details
  js_value_t* sessionsArr = nullptr;
  js_create_array_with_length(env, g_sessionCache.size(), &sessionsArr);

  uint32_t idx = 0;
  for (const auto& [key, entry] : g_sessionCache) {
    js_value_t* sessionObj = nullptr;
    js_create_object(env, &sessionObj);

    // Cache key
    js_value_t* keyVal = nullptr;
    js_create_string_utf8(env, reinterpret_cast<const utf8_t*>(key.c_str()),
                          key.length(), &keyVal);
    js_set_named_property(env, sessionObj, "key", keyVal);

    // Reference count
    js_value_t* refCountVal = nullptr;
    js_create_int32(env, entry.refCount, &refCountVal);
    js_set_named_property(env, sessionObj, "refCount", refCountVal);

    // Model path (extract from key)
    size_t pipePos = key.find('|');
    std::string modelPath = (pipePos != std::string::npos) ? key.substr(0, pipePos) : key;
    js_value_t* pathVal = nullptr;
    js_create_string_utf8(env, reinterpret_cast<const utf8_t*>(modelPath.c_str()),
                          modelPath.length(), &pathVal);
    js_set_named_property(env, sessionObj, "modelPath", pathVal);

    js_set_element(env, sessionsArr, idx++, sessionObj);
  }
  js_set_named_property(env, result, "sessions", sessionsArr);

  return result;
}

OnnxSession* unwrapSession(js_env_t* env, js_value_t* external) {
  void* data = nullptr;
  js_get_value_external(env, external, &data);
  return static_cast<OnnxSession*>(data);
}

}  // namespace js
}  // namespace onnx_addon
