#include "rpc-server-core.hpp"

#include <cstdlib>
#include <filesystem>
#include <stdexcept>

namespace rpc_server {

ServerRunner::ServerRunner(ggml_backend_rpc_server_t server, RpcServerApi api)
    : server_(server), api_(api) {
  worker_ = std::thread([this] { api_.run(server_); });
}

ServerRunner::~ServerRunner() { stop(); }

void ServerRunner::stop() {
  std::scoped_lock lock(stopMutex_);
  if (server_ == nullptr) {
    return;
  }
  api_.stop(server_);
  if (worker_.joinable()) {
    worker_.join();
  }
  api_.free(server_);
  server_ = nullptr;
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
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      .getPort = reinterpret_cast<RpcServerApi::GetPortFn>(
          ggml_backend_reg_get_proc_address(
              rpcBackend, "ggml_backend_rpc_server_get_port")),
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      .rdmaSupported = reinterpret_cast<RpcServerApi::RdmaSupportedFn>(
          ggml_backend_reg_get_proc_address(
              rpcBackend, "ggml_backend_rpc_rdma_supported")),
  };
  if (api.create == nullptr || api.run == nullptr || api.stop == nullptr ||
      api.free == nullptr || api.getPort == nullptr ||
      api.rdmaSupported == nullptr) {
    throw std::runtime_error(
        "the installed @qvac/fabric RPC backend is too old: it does not "
        "provide the managed server, port and RDMA entry points");
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

} // namespace rpc_server
