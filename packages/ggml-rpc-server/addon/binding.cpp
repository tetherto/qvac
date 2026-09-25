#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <bare.h>
#include <ggml-backend.h>
#include <ggml-rpc.h>
#include <js.h>
#include <uv.h>

namespace {

constexpr uint64_t SERVER_MAGIC = UINT64_C(0x5156525043535256);
constexpr size_t MAX_OPTION_STRING_LENGTH = 4096;

std::mutex& startMutex() {
  static std::mutex mutex;
  return mutex;
}

struct RpcServerApi {
  using CreateFn = ggml_backend_rpc_server_t (*)(
      const char*, const char*, size_t, size_t, ggml_backend_dev_t*);
  using RunFn = void (*)(ggml_backend_rpc_server_t);
  using StopFn = void (*)(ggml_backend_rpc_server_t);
  using FreeFn = void (*)(ggml_backend_rpc_server_t);

  CreateFn create;
  RunFn run;
  StopFn stop;
  FreeFn free;
};

struct ServerHandle {
  ServerHandle(ggml_backend_rpc_server_t value, RpcServerApi functions)
      : server(value), api(functions) {
    worker = std::thread([this] { api.run(server); });
  }

  ~ServerHandle() { stop(); }

  ServerHandle(const ServerHandle&) = delete;
  ServerHandle& operator=(const ServerHandle&) = delete;
  ServerHandle(ServerHandle&&) = delete;
  ServerHandle& operator=(ServerHandle&&) = delete;

  void stop() {
    std::scoped_lock lock(stopMutex);
    if (server == nullptr) {
      return;
    }
    api.stop(server);
    if (worker.joinable()) {
      worker.join();
    }
    api.free(server);
    server = nullptr;
  }

  uint64_t magic = SERVER_MAGIC;
  ggml_backend_rpc_server_t server;
  RpcServerApi api;
  std::thread worker;
  std::mutex stopMutex;
};

using ServerHandleRef = std::shared_ptr<ServerHandle>;

class StartError : public std::runtime_error {
public:
  StartError(std::string errorCode, const char* message)
      : std::runtime_error(message), code(std::move(errorCode)) {}

  std::string code;
};

struct StartTask {
  StartTask(
      js_env_t* taskEnv, js_deferred_t* taskDeferred,
      uv_async_t* taskAsyncHandle, std::string taskEndpoint,
      std::string taskDevices, std::string taskBackendsDir, int taskThreads,
      bool taskCache)
      : env(taskEnv), deferred(taskDeferred), asyncHandle(taskAsyncHandle),
        endpoint(std::move(taskEndpoint)), devices(std::move(taskDevices)),
        backendsDir(std::move(taskBackendsDir)), threads(taskThreads),
        cache(taskCache) {}

  js_env_t* env;
  js_deferred_t* deferred;
  uv_async_t* asyncHandle;
  std::string endpoint;
  std::string devices;
  std::string backendsDir;
  int threads;
  bool cache;
  ServerHandleRef holder;
  std::exception_ptr error;
  js_deferred_teardown_t* teardown = nullptr;
  bool envAlive = true;
  bool cleanupStarted = false;
};

struct StopTask {
  StopTask(
      js_env_t* taskEnv, js_deferred_t* taskDeferred,
      uv_async_t* taskAsyncHandle, ServerHandleRef taskHolder)
      : env(taskEnv), deferred(taskDeferred), asyncHandle(taskAsyncHandle),
        holder(std::move(taskHolder)) {}

  js_env_t* env;
  js_deferred_t* deferred;
  uv_async_t* asyncHandle;
  ServerHandleRef holder;
  js_deferred_teardown_t* teardown = nullptr;
  bool envAlive = true;
  std::exception_ptr error;
};

void onStopEnvTeardown(js_deferred_teardown_t* /*unused*/, void* data) {
  static_cast<StopTask*>(data)->envAlive = false;
}

void closeStopTask(uv_handle_t* handle) {
  // libuv embeds uv_handle_t as the first member of every concrete handle.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* asyncHandle = reinterpret_cast<uv_async_t*>(handle);
  std::unique_ptr<uv_async_t> asyncHandleOwner(asyncHandle);
  std::unique_ptr<StopTask> task(static_cast<StopTask*>(asyncHandle->data));
  task->holder.reset();
  task->error = nullptr;
  if (task->teardown != nullptr) {
    js_finish_deferred_teardown_callback(task->teardown);
  }
}

void rejectStopTask(StopTask* task, const char* message) {
  js_value_t* errorMessage = nullptr;
  js_value_t* error = nullptr;
  if (js_create_string_utf8(
          task->env,
          // utf8_t is the JS ABI's byte type.
          // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
          reinterpret_cast<const utf8_t*>(message),
          -1,
          &errorMessage) == 0 &&
      js_create_error(task->env, nullptr, errorMessage, &error) == 0) {
    js_reject_deferred(task->env, task->deferred, error);
  }
}

void completeStopTask(uv_async_t* asyncHandle) {
  auto* task = static_cast<StopTask*>(asyncHandle->data);
  task->holder.reset();

  if (task->envAlive) {
    js_handle_scope_t* scope = nullptr;
    if (js_open_handle_scope(task->env, &scope) == 0) {
      if (task->error != nullptr) {
        try {
          std::rethrow_exception(task->error);
        } catch (const std::exception& error) {
          rejectStopTask(task, error.what());
        } catch (...) {
          rejectStopTask(
              task, "unknown native error while stopping RPC server");
        }
      } else {
        js_value_t* undefinedValue = nullptr;
        if (js_get_undefined(task->env, &undefinedValue) == 0) {
          js_resolve_deferred(task->env, task->deferred, undefinedValue);
        }
      }
      js_close_handle_scope(task->env, scope);
    }
  }

  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  uv_close(reinterpret_cast<uv_handle_t*>(asyncHandle), closeStopTask);
}

js_value_t* stopServerAsync(js_env_t* env, ServerHandleRef holder) {
  js_deferred_t* deferred = nullptr;
  js_value_t* promise = nullptr;
  if (js_create_promise(env, &deferred, &promise) != 0) {
    throw std::runtime_error("failed to create RPC server stop promise");
  }

  uv_loop_t* loop = nullptr;
  if (js_get_env_loop(env, &loop) != 0) {
    throw std::runtime_error("failed to access the Bare event loop");
  }

  auto asyncHandleOwner = std::make_unique<uv_async_t>();
  auto* asyncHandle = asyncHandleOwner.get();
  auto taskOwner =
      std::make_unique<StopTask>(env, deferred, asyncHandle, std::move(holder));
  auto* task = taskOwner.get();
  asyncHandle->data = task;
  if (uv_async_init(loop, asyncHandle, completeStopTask) != 0) {
    throw std::runtime_error("failed to initialize RPC server stop task");
  }
  task = taskOwner.release();
  asyncHandle = asyncHandleOwner.release();

  if (js_add_deferred_teardown_callback(
          env, onStopEnvTeardown, task, &task->teardown) != 0) {
    // Ownership transfers to closeStopTask after uv_async_init succeeds.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    uv_close(reinterpret_cast<uv_handle_t*>(asyncHandle), closeStopTask);
    throw std::runtime_error("failed to register RPC server stop task");
  }

  try {
    std::thread([task] {
      try {
        task->holder->stop();
      } catch (...) {
        task->error = std::current_exception();
      }
      uv_async_send(task->asyncHandle);
    }).detach();
  } catch (...) {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    uv_close(reinterpret_cast<uv_handle_t*>(asyncHandle), closeStopTask);
    throw;
  }

  return promise;
}

void finalizeServer(js_env_t* /*env*/, void* data, void* /*hint*/) {
  std::unique_ptr<ServerHandleRef> holder(static_cast<ServerHandleRef*>(data));
}

bool getOptionalProperty(
    js_env_t* env, js_value_t* object, const char* name, js_value_t** value,
    bool* present) {
  if (js_get_named_property(env, object, name, value) != 0) {
    js_throw_error(env, "InternalError", "failed to read server option");
    return false;
  }
  bool isUndefined = false;
  if (js_is_undefined(env, *value, &isUndefined) != 0) {
    js_throw_error(env, "InternalError", "failed to inspect server option");
    return false;
  }
  *present = !isUndefined;
  return true;
}

bool readString(
    js_env_t* env, js_value_t* object, const char* name, bool required,
    std::string* output) {
  js_value_t* value = nullptr;
  bool present = false;
  if (!getOptionalProperty(env, object, name, &value, &present)) {
    return false;
  }
  if (!present) {
    if (required) {
      const std::string message = std::string(name) + " is required";
      js_throw_type_error(env, "InvalidArgument", message.c_str());
      return false;
    }
    return true;
  }
  size_t length = 0;
  if (js_get_value_string_utf8(env, value, nullptr, 0, &length) != 0 ||
      length > MAX_OPTION_STRING_LENGTH) {
    const std::string message = std::string(name) + " must be a string";
    js_throw_type_error(env, "InvalidArgument", message.c_str());
    return false;
  }
  std::vector<utf8_t> buffer(length + 1);
  size_t copied = 0;
  if (js_get_value_string_utf8(
          env, value, buffer.data(), buffer.size(), &copied) != 0) {
    js_throw_error(env, "InternalError", "failed to read server option");
    return false;
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  output->assign(reinterpret_cast<const char*>(buffer.data()), copied);
  if (required && output->empty()) {
    const std::string message = std::string(name) + " must not be empty";
    js_throw_type_error(env, "InvalidArgument", message.c_str());
    return false;
  }
  return true;
}

bool readPositiveInt(
    js_env_t* env, js_value_t* object, const char* name, int* output) {
  js_value_t* value = nullptr;
  bool present = false;
  if (!getOptionalProperty(env, object, name, &value, &present)) {
    return false;
  }
  if (!present) {
    return true;
  }
  double number = 0;
  if (js_get_value_double(env, value, &number) != 0 || !std::isfinite(number) ||
      number != std::trunc(number) || number <= 0 ||
      number > std::numeric_limits<int>::max()) {
    const std::string message =
        std::string(name) + " must be a positive integer";
    js_throw_type_error(env, "InvalidArgument", message.c_str());
    return false;
  }
  *output = static_cast<int>(number);
  return true;
}

bool readBoolean(
    js_env_t* env, js_value_t* object, const char* name, bool* output) {
  js_value_t* value = nullptr;
  bool present = false;
  if (!getOptionalProperty(env, object, name, &value, &present)) {
    return false;
  }
  if (!present) {
    return true;
  }
  if (js_get_value_bool(env, value, output) != 0) {
    const std::string message = std::string(name) + " must be a boolean";
    js_throw_type_error(env, "InvalidArgument", message.c_str());
    return false;
  }
  return true;
}

std::vector<ggml_backend_dev_t> selectDevices(const std::string& requested) {
  std::vector<ggml_backend_dev_t> devices;
  if (!requested.empty()) {
    size_t begin = 0;
    while (begin <= requested.size()) {
      const size_t end = requested.find_first_of(",/", begin);
      const std::string name = requested.substr(begin, end - begin);
      if (name.empty()) {
        return {};
      }
      ggml_backend_dev_t device = ggml_backend_dev_by_name(name.c_str());
      if (device == nullptr) {
        return {};
      }
      devices.push_back(device);
      if (end == std::string::npos) {
        break;
      }
      begin = end + 1;
    }
  }

  if (devices.empty() && requested.empty()) {
    for (size_t index = 0; index < ggml_backend_dev_count(); ++index) {
      ggml_backend_dev_t device = ggml_backend_dev_get(index);
      if (ggml_backend_dev_type(device) != GGML_BACKEND_DEVICE_TYPE_CPU) {
        devices.push_back(device);
      }
    }
  }
  if (devices.empty() && requested.empty()) {
    ggml_backend_dev_t cpu =
        ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (cpu != nullptr) {
      devices.push_back(cpu);
    }
  }
  return devices;
}

RpcServerApi resolveRpcServerApi() {
  ggml_backend_reg_t rpcBackend = ggml_backend_reg_by_name("RPC");
  if (rpcBackend == nullptr) {
    throw std::runtime_error("RPC backend is not available");
  }

  RpcServerApi api{
      // The ggml backend procedure API returns untyped function addresses.
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      .create = reinterpret_cast<RpcServerApi::CreateFn>(
          ggml_backend_reg_get_proc_address(
              rpcBackend, "ggml_backend_rpc_server_create")),
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      .run = reinterpret_cast<RpcServerApi::RunFn>(
          ggml_backend_reg_get_proc_address(
              rpcBackend, "ggml_backend_rpc_server_run")),
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      .stop = reinterpret_cast<RpcServerApi::StopFn>(
          ggml_backend_reg_get_proc_address(
              rpcBackend, "ggml_backend_rpc_server_stop")),
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      .free = reinterpret_cast<RpcServerApi::FreeFn>(
          ggml_backend_reg_get_proc_address(
              rpcBackend, "ggml_backend_rpc_server_free")),
  };
  if (api.create == nullptr || api.run == nullptr || api.stop == nullptr ||
      api.free == nullptr) {
    throw std::runtime_error(
        "RPC backend does not provide managed server lifecycle functions");
  }
  return api;
}

std::string defaultCacheDirectory() {
  const char* explicitCache = std::getenv("LLAMA_CACHE");
  if (explicitCache != nullptr && *explicitCache != '\0') {
    return (std::filesystem::path(explicitCache) / "rpc").string();
  }
#ifdef _WIN32
  const char* home = std::getenv("LOCALAPPDATA");
#else
  const char* home = std::getenv("HOME");
#endif
  if (home == nullptr || *home == '\0') {
    return {};
  }
#ifdef __APPLE__
  return (std::filesystem::path(home) / "Library" / "Caches" / "llama.cpp" /
          "rpc")
      .string();
#elif defined(_WIN32)
  return (std::filesystem::path(home) / "llama.cpp" / "rpc").string();
#else
  return (std::filesystem::path(home) / ".cache" / "llama.cpp" / "rpc")
      .string();
#endif
}

ServerHandleRef* unwrapServer(js_env_t* env, js_value_t* value) {
  void* data = nullptr;
  if (js_get_value_external(env, value, &data) != 0 || data == nullptr) {
    js_throw_type_error(env, "InvalidArgument", "expected RPC server handle");
    return nullptr;
  }
  auto* handle = static_cast<ServerHandleRef*>(data);
  if (*handle == nullptr || (*handle)->magic != SERVER_MAGIC) {
    js_throw_type_error(env, "InvalidArgument", "expected RPC server handle");
    return nullptr;
  }
  return handle;
}

ServerHandleRef createServerOnWorker(const StartTask& task) {
  // GGML's backend registry is process-global. Preserve the old serialized
  // startup behavior when multiple callers start servers concurrently.
  std::scoped_lock lock(startMutex());
  std::filesystem::path backendPath = task.backendsDir;
#ifdef BACKENDS_SUBDIR
  backendPath /= BACKENDS_SUBDIR;
#endif
  ggml_backend_load_all_from_path(backendPath.string().c_str());
  const RpcServerApi rpcApi = resolveRpcServerApi();

  std::vector<ggml_backend_dev_t> devices = selectDevices(task.devices);
  if (devices.empty()) {
    throw StartError(
        "RpcServerDeviceError",
        task.devices.empty() ? "no RPC server devices are available"
                             : "an unknown RPC server device was requested");
  }

  std::string cacheDirectory;
  const char* cachePath = nullptr;
  if (task.cache) {
    cacheDirectory = defaultCacheDirectory();
    if (cacheDirectory.empty()) {
      throw StartError(
          "RpcServerCacheError",
          "cannot determine the RPC server cache directory");
    }
    std::error_code error;
    std::filesystem::create_directories(cacheDirectory, error);
    if (error) {
      throw StartError(
          "RpcServerCacheError",
          "failed to create the RPC server cache directory");
    }
    cachePath = cacheDirectory.c_str();
  }

  ggml_backend_rpc_server_t server = rpcApi.create(
      task.endpoint.c_str(),
      cachePath,
      static_cast<size_t>(task.threads),
      devices.size(),
      devices.data());
  if (server == nullptr) {
    throw StartError(
        "RpcServerStartError",
        "failed to initialize or bind the in-process RPC server");
  }

  try {
    return std::make_shared<ServerHandle>(server, rpcApi);
  } catch (...) {
    rpcApi.free(server);
    throw;
  }
}

void onStartEnvTeardown(js_deferred_teardown_t* /*unused*/, void* data) {
  static_cast<StartTask*>(data)->envAlive = false;
}

void closeStartTask(uv_handle_t* handle) {
  // libuv embeds uv_handle_t as the first member of every concrete handle.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* asyncHandle = reinterpret_cast<uv_async_t*>(handle);
  std::unique_ptr<uv_async_t> asyncHandleOwner(asyncHandle);
  std::unique_ptr<StartTask> task(static_cast<StartTask*>(asyncHandle->data));
  if (task->teardown != nullptr) {
    js_finish_deferred_teardown_callback(task->teardown);
  }
}

void rejectStartTask(
    StartTask* task, const std::string& code, const char* message) {
  js_value_t* errorCode = nullptr;
  js_value_t* errorMessage = nullptr;
  js_value_t* error = nullptr;
  // utf8_t is the JS ABI's byte type.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto* codeBytes = reinterpret_cast<const utf8_t*>(code.c_str());
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto* messageBytes = reinterpret_cast<const utf8_t*>(message);
  if (js_create_string_utf8(task->env, codeBytes, -1, &errorCode) == 0 &&
      js_create_string_utf8(task->env, messageBytes, -1, &errorMessage) == 0 &&
      js_create_error(task->env, errorCode, errorMessage, &error) == 0) {
    js_reject_deferred(task->env, task->deferred, error);
  }
}

void reportStartError(StartTask* task) {
  try {
    std::rethrow_exception(task->error);
  } catch (const StartError& error) {
    rejectStartTask(task, error.code, error.what());
  } catch (const std::bad_alloc&) {
    rejectStartTask(task, "OutOfMemory", "failed to allocate RPC server state");
  } catch (const std::exception& error) {
    rejectStartTask(task, "RpcServerStartError", error.what());
  } catch (...) {
    rejectStartTask(task, "RpcServerStartError", "unknown native error");
  }
}

void resolveStartTask(StartTask* task) {
  std::unique_ptr<ServerHandleRef> externalHolder(
      new (std::nothrow) ServerHandleRef(task->holder));
  js_value_t* external = nullptr;
  if (externalHolder == nullptr || js_create_external(
                                       task->env,
                                       externalHolder.get(),
                                       finalizeServer,
                                       nullptr,
                                       &external) != 0) {
    rejectStartTask(
        task, "InternalError", "failed to create RPC server handle");
    return;
  }
  // The JS external now owns this shared reference until finalizeServer runs.
  [[maybe_unused]] auto* jsOwnedHolder = externalHolder.release();
  if (js_resolve_deferred(task->env, task->deferred, external) == 0) {
    task->holder.reset();
  }
}

bool stopAbandonedStart(StartTask* task) {
  if (task->holder == nullptr) {
    return false;
  }
  // A result that cannot reach JS must be stopped off the JS thread. Keep
  // teardown deferred until that stop finishes.
  task->cleanupStarted = true;
  try {
    std::thread([task] {
      try {
        task->holder->stop();
      } catch (...) {
        task->error = std::current_exception();
      }
      uv_async_send(task->asyncHandle);
    }).detach();
    return true;
  } catch (...) {
    // Thread creation failed; reclaim the server before closing the task.
    try {
      task->holder->stop();
    } catch (...) {
      task->error = std::current_exception();
    }
    task->holder.reset();
    return false;
  }
}

void completeStartTask(uv_async_t* asyncHandle) {
  auto* task = static_cast<StartTask*>(asyncHandle->data);
  if (task->cleanupStarted) {
    task->holder.reset();
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    uv_close(reinterpret_cast<uv_handle_t*>(asyncHandle), closeStartTask);
    return;
  }

  if (task->envAlive) {
    js_handle_scope_t* scope = nullptr;
    if (js_open_handle_scope(task->env, &scope) == 0) {
      if (task->error != nullptr) {
        reportStartError(task);
      } else {
        resolveStartTask(task);
      }
      js_close_handle_scope(task->env, scope);
    }
  }

  if (stopAbandonedStart(task)) {
    return;
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  uv_close(reinterpret_cast<uv_handle_t*>(asyncHandle), closeStartTask);
}

js_value_t* startServerAsync(
    js_env_t* env, std::string endpoint, std::string devices,
    std::string backendsDir, int threads, bool cache) {
  js_deferred_t* deferred = nullptr;
  js_value_t* promise = nullptr;
  if (js_create_promise(env, &deferred, &promise) != 0) {
    throw std::runtime_error("failed to create RPC server start promise");
  }

  uv_loop_t* loop = nullptr;
  if (js_get_env_loop(env, &loop) != 0) {
    throw std::runtime_error("failed to access the Bare event loop");
  }

  auto asyncHandleOwner = std::make_unique<uv_async_t>();
  auto* asyncHandle = asyncHandleOwner.get();
  auto taskOwner = std::make_unique<StartTask>(
      env,
      deferred,
      asyncHandle,
      std::move(endpoint),
      std::move(devices),
      std::move(backendsDir),
      threads,
      cache);
  auto* task = taskOwner.get();
  asyncHandle->data = task;
  if (uv_async_init(loop, asyncHandle, completeStartTask) != 0) {
    throw std::runtime_error("failed to initialize RPC server start task");
  }
  task = taskOwner.release();
  asyncHandle = asyncHandleOwner.release();

  if (js_add_deferred_teardown_callback(
          env, onStartEnvTeardown, task, &task->teardown) != 0) {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    uv_close(reinterpret_cast<uv_handle_t*>(asyncHandle), closeStartTask);
    throw std::runtime_error("failed to register RPC server start task");
  }

  try {
    std::thread([task] {
      try {
        task->holder = createServerOnWorker(*task);
      } catch (...) {
        task->error = std::current_exception();
      }
      uv_async_send(task->asyncHandle);
    }).detach();
  } catch (...) {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    uv_close(reinterpret_cast<uv_handle_t*>(asyncHandle), closeStartTask);
    throw;
  }

  return promise;
}

js_value_t* startServer(js_env_t* env, js_callback_info_t* info) try {
  size_t argc = 1;
  std::array<js_value_t*, 1> argv{nullptr};
  if (js_get_callback_info(env, info, &argc, argv.data(), nullptr, nullptr) !=
      0) {
    return nullptr;
  }
  if (argc != 1) {
    js_throw_type_error(env, "InvalidArgument", "server options are required");
    return nullptr;
  }
  js_value_t* options = argv.front();

  std::string endpoint;
  std::string devicesValue;
  std::string backendsDir;
  const unsigned int defaultThreads =
      std::max(1U, std::thread::hardware_concurrency() / 2);
  int threads = static_cast<int>(std::min(
      defaultThreads,
      static_cast<unsigned int>(std::numeric_limits<int>::max())));
  bool cache = false;
  if (!readString(env, options, "endpoint", true, &endpoint) ||
      !readString(env, options, "device", false, &devicesValue) ||
      !readString(env, options, "backendsDir", true, &backendsDir) ||
      !readPositiveInt(env, options, "threads", &threads) ||
      !readBoolean(env, options, "cache", &cache)) {
    return nullptr;
  }

  const std::filesystem::path backendPath = backendsDir;
  // Mobile prebuilds are bundled under a virtual app path, not a filesystem
  // directory. ggml loads Android backends by name when that path is absent.
  if (!backendPath.is_absolute()) {
    js_throw_error(
        env, "RpcServerBackendError", "backendsDir must be an absolute path");
    return nullptr;
  }
  return startServerAsync(
      env, std::move(endpoint), std::move(devicesValue),
      std::move(backendsDir), threads, cache);
} catch (const std::bad_alloc&) {
  js_throw_error(env, "OutOfMemory", "failed to allocate RPC server state");
  return nullptr;
} catch (const std::exception& error) {
  js_throw_error(env, "RpcServerStartError", error.what());
  return nullptr;
} catch (...) {
  js_throw_error(env, "RpcServerStartError", "unknown native error");
  return nullptr;
}

js_value_t* stopServer(js_env_t* env, js_callback_info_t* info) try {
  size_t argc = 1;
  std::array<js_value_t*, 1> argv{nullptr};
  if (js_get_callback_info(env, info, &argc, argv.data(), nullptr, nullptr) !=
      0) {
    return nullptr;
  }
  if (argc != 1) {
    js_throw_type_error(
        env, "InvalidArgument", "RPC server handle is required");
    return nullptr;
  }
  ServerHandleRef* handle = unwrapServer(env, argv.front());
  if (handle == nullptr) {
    return nullptr;
  }
  return stopServerAsync(env, *handle);
} catch (const std::exception& error) {
  js_throw_error(env, "RpcServerStopError", error.what());
  return nullptr;
} catch (...) {
  js_throw_error(env, "RpcServerStopError", "unknown native error");
  return nullptr;
}

js_value_t* rpcServerExports(js_env_t* env, js_value_t* target) {
// Native export registration is intentionally expressed as the same compact
// macro used by the neighboring Bare addons.
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, function)                                                      \
  {                                                                            \
    js_value_t* value = nullptr;                                               \
    if (js_create_function(env, name, -1, function, nullptr, &value) != 0 ||   \
        js_set_named_property(env, target, name, value) != 0) {                \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("startServer", startServer)
  V("stopServer", stopServer)

#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)
  return target;
}

} // namespace

BARE_MODULE("ggml-rpc-server-addon", rpcServerExports)
