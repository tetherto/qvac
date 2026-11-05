#include <algorithm>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <ggml-backend.h>
#include <gtest/gtest.h>

#include "rpc-server-core.hpp"

namespace {

using rpc_server::RpcServerApi;
using rpc_server::ServerRunner;

// Stands in for a ggml RPC server: run() blocks until stop() is called, as the
// real server's accept loop does.
struct FakeServer {
  std::mutex mutex;
  std::condition_variable stopRequestedChanged;
  bool stopRequested = false;
  int runCalls = 0;
  int stopCalls = 0;
  int freeCalls = 0;
  std::thread::id runThread;
  std::vector<std::string> events;
};

FakeServer* fakeFrom(ggml_backend_rpc_server_t server) {
  // The fake handle is a FakeServer*, cast to the opaque ggml server type.
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return reinterpret_cast<FakeServer*>(server);
}

ggml_backend_rpc_server_t handleFor(FakeServer& fake) {
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  return reinterpret_cast<ggml_backend_rpc_server_t>(&fake);
}

void fakeRun(ggml_backend_rpc_server_t server) {
  FakeServer* fake = fakeFrom(server);
  std::unique_lock lock(fake->mutex);
  ++fake->runCalls;
  fake->runThread = std::this_thread::get_id();
  fake->events.emplace_back("run");
  fake->stopRequestedChanged.wait(lock, [fake] { return fake->stopRequested; });
  fake->events.emplace_back("run-returned");
}

void fakeStop(ggml_backend_rpc_server_t server) {
  FakeServer* fake = fakeFrom(server);
  {
    std::scoped_lock lock(fake->mutex);
    ++fake->stopCalls;
    fake->stopRequested = true;
    fake->events.emplace_back("stop");
  }
  fake->stopRequestedChanged.notify_all();
}

void fakeFree(ggml_backend_rpc_server_t server) {
  FakeServer* fake = fakeFrom(server);
  std::scoped_lock lock(fake->mutex);
  ++fake->freeCalls;
  fake->events.emplace_back("free");
}

RpcServerApi fakeApi() {
  return RpcServerApi{
      .create = nullptr,
      .run = fakeRun,
      .stop = fakeStop,
      .free = fakeFree,
      .getPort = nullptr,
      .rdmaSupported = nullptr,
  };
}

void expectStoppedOnce(FakeServer& fake) {
  std::scoped_lock lock(fake.mutex);
  EXPECT_EQ(fake.runCalls, 1);
  EXPECT_EQ(fake.stopCalls, 1);
  EXPECT_EQ(fake.freeCalls, 1);
  // free() must follow the worker's exit, or the server is freed while running.
  ASSERT_FALSE(fake.events.empty());
  EXPECT_EQ(fake.events.back(), "free");
  EXPECT_NE(std::ranges::find(fake.events, "run-returned"), fake.events.end());
}

TEST(ServerRunner, RunsTheServerOnItsOwnThread) {
  FakeServer fake;
  ServerRunner runner(handleFor(fake), fakeApi());
  runner.stop();

  std::scoped_lock lock(fake.mutex);
  EXPECT_NE(fake.runThread, std::thread::id());
  EXPECT_NE(fake.runThread, std::this_thread::get_id());
}

TEST(ServerRunner, StopJoinsTheWorkerBeforeFreeing) {
  FakeServer fake;
  ServerRunner runner(handleFor(fake), fakeApi());
  runner.stop();
  expectStoppedOnce(fake);
}

TEST(ServerRunner, RepeatedStopIsANoOp) {
  FakeServer fake;
  ServerRunner runner(handleFor(fake), fakeApi());
  runner.stop();
  runner.stop();
  expectStoppedOnce(fake);
}

TEST(ServerRunner, ConcurrentStopsFreeOnce) {
  FakeServer fake;
  ServerRunner runner(handleFor(fake), fakeApi());
  std::thread first([&runner] { runner.stop(); });
  std::thread second([&runner] { runner.stop(); });
  first.join();
  second.join();
  expectStoppedOnce(fake);
}

TEST(ServerRunner, DestructorStopsARunningServer) {
  FakeServer fake;
  {
    ServerRunner runner(handleFor(fake), fakeApi());
  }
  expectStoppedOnce(fake);
}

// qvac_addon_stage_fabric_for_test() stages Fabric's backends, including the
// RPC backend, next to the test binary. Nothing is registered until they load.
class BackendTest : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    static std::once_flag loaded;
    std::call_once(
        loaded, [] { ggml_backend_load_all_from_path(GGML_BACKEND_DIR); });
  }
};

using SelectDevices = BackendTest;
using ResolveRpcServerApi = BackendTest;

TEST_F(SelectDevices, EmptyRequestPrefersNonCpuDevices) {
  const std::vector<ggml_backend_dev_t> devices = rpc_server::selectDevices("");
  ASSERT_FALSE(devices.empty());

  bool hasNonCpu = false;
  for (size_t index = 0; index < ggml_backend_dev_count(); ++index) {
    if (ggml_backend_dev_type(ggml_backend_dev_get(index)) !=
        GGML_BACKEND_DEVICE_TYPE_CPU) {
      hasNonCpu = true;
    }
  }
  for (ggml_backend_dev_t device : devices) {
    EXPECT_EQ(
        ggml_backend_dev_type(device) == GGML_BACKEND_DEVICE_TYPE_CPU,
        !hasNonCpu);
  }
  if (!hasNonCpu) {
    EXPECT_EQ(devices.size(), 1U);
  }
}

TEST_F(SelectDevices, SelectsANamedDevice) {
  const std::vector<ggml_backend_dev_t> devices =
      rpc_server::selectDevices("CPU");
  ASSERT_EQ(devices.size(), 1U);
  EXPECT_EQ(
      ggml_backend_dev_type(devices.front()), GGML_BACKEND_DEVICE_TYPE_CPU);
}

TEST_F(SelectDevices, AcceptsCommaAndSlashSeparators) {
  EXPECT_EQ(rpc_server::selectDevices("CPU,CPU").size(), 2U);
  EXPECT_EQ(rpc_server::selectDevices("CPU/CPU").size(), 2U);
}

TEST_F(SelectDevices, RejectsUnknownOrEmptyNames) {
  for (const char* requested : {
           "__qvac_unknown__",
           "CPU,__qvac_unknown__",
           "CPU,",
           ",CPU",
           "CPU,,CPU",
           "/",
       }) {
    EXPECT_TRUE(rpc_server::selectDevices(requested).empty()) << requested;
  }
}

TEST_F(ResolveRpcServerApi, FindsTheLifecycleEntryPoints) {
  const RpcServerApi api = rpc_server::resolveRpcServerApi();
  EXPECT_NE(api.create, nullptr);
  EXPECT_NE(api.run, nullptr);
  EXPECT_NE(api.stop, nullptr);
  EXPECT_NE(api.free, nullptr);
  EXPECT_NE(api.getPort, nullptr);
  EXPECT_NE(api.rdmaSupported, nullptr);
}

#ifdef _WIN32
constexpr const char* HOME_VARIABLE = "LOCALAPPDATA";
#else
constexpr const char* HOME_VARIABLE = "HOME";
#endif

void setVariable(const char* name, const std::optional<std::string>& value) {
#ifdef _WIN32
  _putenv_s(name, value.has_value() ? value->c_str() : "");
#else
  if (value.has_value()) {
    setenv(name, value->c_str(), 1);
  } else {
    unsetenv(name);
  }
#endif
}

// Sets environment variables for one test and restores them afterwards.
class ScopedEnvironment {
public:
  ScopedEnvironment(
      const std::optional<std::string>& llamaCache,
      const std::optional<std::string>& home) {
    for (const char* name : {"LLAMA_CACHE", HOME_VARIABLE}) {
      const char* current = std::getenv(name);
      saved_.emplace_back(
          name,
          current == nullptr ? std::nullopt
                             : std::optional<std::string>(current));
    }
    setVariable("LLAMA_CACHE", llamaCache);
    setVariable(HOME_VARIABLE, home);
  }
  ~ScopedEnvironment() {
    for (const auto& [name, value] : saved_) {
      setVariable(name, value);
    }
  }

  ScopedEnvironment(const ScopedEnvironment&) = delete;
  ScopedEnvironment& operator=(const ScopedEnvironment&) = delete;
  ScopedEnvironment(ScopedEnvironment&&) = delete;
  ScopedEnvironment& operator=(ScopedEnvironment&&) = delete;

private:
  std::vector<std::pair<const char*, std::optional<std::string>>> saved_;
};

std::filesystem::path testRoot() {
  return std::filesystem::temp_directory_path() / "qvac-rpc-cache";
}

TEST(DefaultCacheDirectory, LlamaCacheTakesPrecedence) {
  const ScopedEnvironment env(testRoot().string(), testRoot().string());
  EXPECT_EQ(rpc_server::defaultCacheDirectory(), (testRoot() / "rpc").string());
}

TEST(DefaultCacheDirectory, FallsBackToThePlatformCacheDirectory) {
  const ScopedEnvironment env(std::nullopt, testRoot().string());
#ifdef __APPLE__
  const std::filesystem::path expected =
      testRoot() / "Library" / "Caches" / "llama.cpp" / "rpc";
#elif defined(_WIN32)
  const std::filesystem::path expected = testRoot() / "llama.cpp" / "rpc";
#else
  const std::filesystem::path expected =
      testRoot() / ".cache" / "llama.cpp" / "rpc";
#endif
  EXPECT_EQ(rpc_server::defaultCacheDirectory(), expected.string());
}

TEST(DefaultCacheDirectory, EmptyLlamaCacheIsIgnored) {
#ifdef _WIN32
  GTEST_SKIP() << "Windows cannot hold an empty environment variable";
#endif
  const ScopedEnvironment env(std::string(), testRoot().string());
  EXPECT_NE(
      rpc_server::defaultCacheDirectory().find("llama.cpp"), std::string::npos);
}

TEST(DefaultCacheDirectory, NoBaseDirectoryYieldsEmpty) {
  const ScopedEnvironment env(std::nullopt, std::nullopt);
  EXPECT_TRUE(rpc_server::defaultCacheDirectory().empty());
}

} // namespace
