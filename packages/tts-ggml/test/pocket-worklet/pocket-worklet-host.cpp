// Standalone iOS Simulator host for the packaged Pocket Bare worklet test.
// Uses the same exported Bare Kit C API as react-native-bare-kit/shared/
// BareKitModule.cc. Keep IPC initialization after bare_worklet_start().
// This tests a worklet process, not a signed app or a physical device.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

#include <dlfcn.h>
extern "C" {
struct bare_worklet_s;
using bare_worklet_t = bare_worklet_s;
struct bare_ipc_s;
using bare_ipc_t = bare_ipc_s;
struct uv_buf_t {
  char* base;
  size_t len;
};
struct bare_worklet_options_t {
  size_t memory_limit;
  const char* assets;
};
int bare_worklet_alloc(bare_worklet_t**);
int bare_worklet_init(bare_worklet_t*, const bare_worklet_options_t*);
int bare_worklet_start(
    bare_worklet_t*, const char*, const uv_buf_t*, int, const char*[]);
int bare_worklet_terminate(bare_worklet_t*);
void bare_worklet_destroy(bare_worklet_t*);
int bare_ipc_alloc(bare_ipc_t**);
int bare_ipc_init(bare_ipc_t*, bare_worklet_t*);
int bare_ipc_read(bare_ipc_t*, void**, size_t*);
void bare_ipc_destroy(bare_ipc_t*);
}
void check(int code, const char* stage) {
  if (code) {
    std::fprintf(stderr, "%s: %d\n", stage, code);
    std::exit(2);
  }
}
int main(int argc, char** argv) {
  if (argc < 2)
    return 2;
  // A broken native job must not leave an orphaned simulator process if its
  // termination path hangs. Ordinary completion exits before this deadline.
  std::thread([] {
    std::this_thread::sleep_for(std::chrono::seconds(120));
    std::fprintf(stderr, "Worklet host exceeded its hard deadline\n");
    std::_Exit(124);
  }).detach();
  for (int i = 2; i < argc; ++i)
    if (!dlopen(argv[i], RTLD_NOW | RTLD_GLOBAL)) {
      std::fprintf(stderr, "%s\n", dlerror());
      return 3;
    }
  bare_worklet_t* worklet;
  bare_ipc_t* ipc;
  check(bare_worklet_alloc(&worklet), "worklet alloc");
  bare_worklet_options_t options{0, nullptr};
  check(bare_worklet_init(worklet, &options), "worklet init");
  check(
      bare_worklet_start(worklet, argv[1], nullptr, 0, nullptr),
      "worklet start");
  check(bare_ipc_alloc(&ipc), "ipc alloc");
  check(bare_ipc_init(ipc, worklet), "ipc init");
  std::string received;
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(90);
  while (std::chrono::steady_clock::now() < deadline) {
    void* data = nullptr;
    size_t len = 0;
    int result = bare_ipc_read(ipc, &data, &len);
    if (result == 0)
      received.append(static_cast<const char*>(data), len);
    else if (result != -1) {
      std::fprintf(stderr, "ipc read %d\n", result);
      break;
    }
    if (received.find('\n') != std::string::npos)
      break;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  std::printf("WORKLET_RESULT %s\n", received.c_str());
  std::fflush(stdout);
  check(bare_worklet_terminate(worklet), "worklet terminate");
  bare_ipc_destroy(ipc);
  std::free(ipc);
  bare_worklet_destroy(worklet);
  std::free(worklet);
  return received.find("\"passed\":true") != std::string::npos ? 0 : 1;
}
