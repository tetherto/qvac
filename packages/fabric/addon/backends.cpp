#include "qvac-fabric.h"

#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <string>
#include <system_error>

#include <ggml-backend.h>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace fs = std::filesystem;

namespace {

std::string utf8(const fs::path& path) {
  const auto u8 = path.u8string();
  return {reinterpret_cast<const char*>(u8.data()), u8.size()};
}

// The file this runtime was loaded from, found through an address inside it:
// it is wherever the platform package, bare-link or the APK put it, and only
// the loader knows which.
fs::path runtimePath() {
#if defined(_WIN32)
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(&qvac_fabric_backends_dir),
          &module)) {
    return {};
  }
  std::wstring buffer(MAX_PATH, L'\0');
  for (;;) {
    const DWORD length = GetModuleFileNameW(
        module, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0) return {};
    if (length < buffer.size()) {
      buffer.resize(length);
      return fs::path(buffer);
    }
    buffer.resize(buffer.size() * 2);
  }
#else
  Dl_info info{};
  if (dladdr(reinterpret_cast<void*>(&qvac_fabric_backends_dir), &info) == 0 ||
      info.dli_fname == nullptr) {
    return {};
  }
  return fs::path(info.dli_fname);
#endif
}

std::string findBackendsDir() {
  if (const char* env = std::getenv("QVAC_FABRIC_BACKENDS_DIR");
      env != nullptr && *env != '\0') {
    return env;
  }

  const fs::path self = runtimePath();
  if (self.empty()) return {};

  const fs::path dir = self.parent_path();
  std::error_code ec;
  const fs::path nested = dir / QVAC_FABRIC_MODULE_NAME;
  if (fs::is_directory(nested, ec)) return utf8(nested);
  return utf8(dir);
}

std::once_flag dirOnce;
std::string dir;

std::once_flag loadOnce;

}  // namespace

extern "C" const char* qvac_fabric_backends_dir(void) {
  std::call_once(dirOnce, [] { dir = findBackendsDir(); });
  return dir.c_str();
}

extern "C" size_t qvac_fabric_load_backends(void) {
  std::call_once(loadOnce, [] {
    const char* path = qvac_fabric_backends_dir();
    ggml_backend_load_all_from_path(*path != '\0' ? path : nullptr);
  });
  return ggml_backend_reg_count();
}
