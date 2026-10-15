#pragma once

// Server logic with no Bare or JS dependency, so C++ unit tests can link it.

#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <ggml-backend.h>
#include <ggml-rpc.h>

namespace rpc_server {

struct RpcServerApi {
  using CreateFn = ggml_backend_rpc_server_t (*)(
      const char*, const char*, size_t, size_t, ggml_backend_dev_t*);
  using RunFn = void (*)(ggml_backend_rpc_server_t);
  using StopFn = void (*)(ggml_backend_rpc_server_t);
  using FreeFn = void (*)(ggml_backend_rpc_server_t);
  using GetPortFn = int (*)(ggml_backend_rpc_server_t);
  using RdmaSupportedFn = bool (*)();

  CreateFn create;
  RunFn run;
  StopFn stop;
  FreeFn free;
  // The port a created server is listening on, which resolves port 0.
  GetPortFn getPort;
  // Whether new connections will try RDMA before falling back to TCP.
  RdmaSupportedFn rdmaSupported;
};

// Runs a created server on its own thread. stop() stops, joins and frees it
// exactly once; the destructor stops a server that is still running.
class ServerRunner {
public:
  ServerRunner(ggml_backend_rpc_server_t server, RpcServerApi api);
  ~ServerRunner();

  ServerRunner(const ServerRunner&) = delete;
  ServerRunner& operator=(const ServerRunner&) = delete;
  ServerRunner(ServerRunner&&) = delete;
  ServerRunner& operator=(ServerRunner&&) = delete;

  void stop();

private:
  ggml_backend_rpc_server_t server_;
  RpcServerApi api_;
  std::mutex stopMutex_;
  std::thread worker_;
};

// Resolves a comma- or slash-separated device list. An empty request selects
// every non-CPU device, falling back to the CPU. Returns no devices when any
// requested name is empty or unknown.
std::vector<ggml_backend_dev_t> selectDevices(const std::string& requested);

// Reads the server entry points from the registered RPC backend. Throws
// std::runtime_error when the backend or any entry point is missing.
RpcServerApi resolveRpcServerApi();

// The llama.cpp RPC cache directory, or an empty string when no base
// directory is set in the environment.
std::string defaultCacheDirectory();

} // namespace rpc_server
