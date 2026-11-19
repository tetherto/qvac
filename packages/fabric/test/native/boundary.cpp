#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <ggml-backend.h>
#include <ggml.h>

#ifdef _WIN32
#ifndef _DEBUG
#error Windows allocation ownership coverage requires a Debug build with /MTd
#endif
#include <windows.h>
#ifdef _DEBUG
#include <crtdbg.h>
#endif
#else
#include <dlfcn.h>
#endif

namespace {
int fail(const char* message) {
  std::fprintf(stderr, "FAIL: %s\n", message);
  return 1;
}

#if defined(_WIN32) && defined(_DEBUG)
int crtAssertions = 0;
int crtReport(int type, char*, int* result) {
  if (type == _CRT_ASSERT) {
    ++crtAssertions;
    *result = 0;
    return TRUE;
  }
  return FALSE;
}
#endif

int allocation(const char* path) {
  // ggml's loader returns the actual module registry. Do not fall back to a
  // statically registered CPU or another available device when loading fails.
  auto reg = ggml_backend_load(path);
  if (!reg)
    return fail("requested backend could not be loaded");
  const size_t count = ggml_backend_reg_dev_count(reg);
  if (count == 0)
    return fail("requested backend has no devices");
  for (size_t d = 0; d < count; ++d) {
    auto device = ggml_backend_reg_dev_get(reg, d);
    auto type = ggml_backend_dev_buffer_type(device);
    if (!type)
      return fail("backend has no default buffer type");
    for (size_t i = 0; i < 16; ++i) {
      const size_t size = 4096 + i * 64;
      auto buffer = ggml_backend_buft_alloc_buffer(type, size);
      if (!buffer)
        return fail("backend allocation failed");
      if (ggml_backend_buffer_get_size(buffer) < size)
        return fail("undersized buffer");
      ggml_backend_buffer_clear(buffer, 0x5a);
      // The backend allocated the descriptor; the caller's core frees it.
      // This is the ownership seam that fails with separate /MTd CRTs.
      ggml_backend_buffer_free(buffer);
    }
  }
  ggml_backend_unload(reg);
#if defined(_WIN32) && defined(_DEBUG)
  if (crtAssertions)
    return fail("cross-module allocation/free triggered CRT assertions");
#endif
  return 0;
}

struct LogState {
  int received = 0;
};

void logCallback(enum ggml_log_level level, const char* text, void* data) {
  if (level == GGML_LOG_LEVEL_INFO &&
      std::strcmp(text, "qvac-boundary-log") == 0) {
    ++static_cast<LogState*>(data)->received;
  }
}

void abortCallback(const char* message) {
  std::_Exit(std::strstr(message, "qvac-boundary-abort") ? 86 : 87);
}

int callbacks(const char* mode, const char* path) {
  ggml_log_callback original = nullptr;
  void* originalData = nullptr;
  ggml_log_get(&original, &originalData);
  LogState first;
  LogState second;
  // Install BEFORE dlopen: loading a new module must not create fresh state.
  ggml_log_set(logCallback, &first);
  ggml_set_abort_callback(abortCallback);
#ifdef _WIN32
  auto handle = LoadLibraryA(path);
  if (!handle)
    return fail("callback module could not be loaded");
  auto emit = reinterpret_cast<void (*)()>(GetProcAddress(
      handle,
      std::strcmp(mode, "logger") == 0 ? "qvac_test_log" : "qvac_test_abort"));
#else
  auto handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!handle) {
    std::fprintf(stderr, "%s\n", dlerror());
    return fail("callback module could not be loaded");
  }
  auto emit = reinterpret_cast<void (*)()>(dlsym(
      handle,
      std::strcmp(mode, "logger") == 0 ? "qvac_test_log" : "qvac_test_abort"));
#endif
  if (!emit)
    return fail("callback module entry point missing");
  emit(); // abort mode must exit inside abortCallback, never return.
  if (std::strcmp(mode, "abort") == 0)
    return fail("abort emitter returned");
  ggml_log_set(logCallback, &second);
  emit();
  ggml_log_set(original, originalData);
  // Teardown must release stack-owned userdata before another module log.
  ggml_log_set(nullptr, nullptr);
  emit();
  ggml_log_set(original, originalData);
#ifdef _WIN32
  FreeLibrary(handle);
#else
  dlclose(handle);
#endif
  if (first.received != 1 || second.received != 1) {
    return fail(
        "module did not observe caller logger registration/replacement");
  }
  return 0;
}
} // namespace

int main(int argc, char** argv) {
#if defined(_WIN32) && defined(_DEBUG)
  _CrtSetReportHook(crtReport);
  _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
  _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
#endif
  if (argc != 3)
    return fail("usage: boundary allocation|logger|abort MODULE");
  if (std::strcmp(argv[1], "allocation") == 0)
    return allocation(argv[2]);
  if (std::strcmp(argv[1], "logger") == 0 ||
      std::strcmp(argv[1], "abort") == 0) {
    return callbacks(argv[1], argv[2]);
  }
  return fail("unknown test mode");
}
