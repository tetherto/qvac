#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <string>
#include <system_error>
#include <vector>

#include <ggml-backend.h>

#include "backend-packages.h"
#include "qvac-fabric.h"

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
fs::path modulePath(const void* address) {
#if defined(_WIN32)
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(address),
          &module)) {
    return {};
  }
  std::wstring buffer(MAX_PATH, L'\0');
  for (;;) {
    const DWORD length = GetModuleFileNameW(
        module, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0)
      return {};
    if (length < buffer.size()) {
      buffer.resize(length);
      return fs::path(buffer);
    }
    buffer.resize(buffer.size() * 2);
  }
#else
  Dl_info info{};
  if (dladdr(address, &info) == 0 || info.dli_fname == nullptr) {
    return {};
  }
  return fs::path(info.dli_fname);
#endif
}

std::string moduleBackendsDir(const void* address, const char* moduleName) {
  const fs::path self = modulePath(address);
  if (self.empty())
    return {};

  const fs::path dir = self.parent_path();
  std::error_code ec;
  const fs::path nested = dir / moduleName;
  if (fs::is_directory(nested, ec))
    return utf8(nested);
  return utf8(dir);
}

std::string findBackendsDir() {
  if (const char* env = std::getenv("QVAC_FABRIC_BACKENDS_DIR");
      env != nullptr && *env != '\0') {
    return env;
  }

  return moduleBackendsDir(
      reinterpret_cast<const void*>(&qvac_fabric_backends_dir),
      QVAC_FABRIC_MODULE_NAME);
}

std::once_flag g_dirOnce;
std::string g_dir;

std::once_flag g_loadOnce;
std::mutex g_packagesMutex;
struct BackendPackage {
  std::string dir;
  std::string file;
};
std::vector<BackendPackage> g_packages;

} // namespace

extern "C" void qvac_fabric_register_backend_package(
    const void* address, const char* module_name, const char* backend_file) {
  const std::string dir = moduleBackendsDir(address, module_name);
  if (dir.empty())
    return;
  const std::lock_guard<std::mutex> lock(g_packagesMutex);
  const std::string file = utf8(fs::path(dir) / backend_file);
  if (std::none_of(
          g_packages.begin(), g_packages.end(), [&](const auto& package) {
            return package.file == file;
          })) {
    g_packages.push_back({dir, file});
  }
}

extern "C" const char* qvac_fabric_backends_dir(void) {
  std::call_once(g_dirOnce, [] { g_dir = findBackendsDir(); });
  return g_dir.c_str();
}

extern "C" size_t qvac_fabric_load_backends(void) {
  std::call_once(g_loadOnce, [] {
    const char* path = qvac_fabric_backends_dir();
    // The environment override remains exclusive, as it was before the split.
    if (const char* env = std::getenv("QVAC_FABRIC_BACKENDS_DIR");
        env != nullptr && *env != '\0') {
      ggml_backend_load_all_from_path(path);
      return;
    }
    const std::lock_guard<std::mutex> lock(g_packagesMutex);
    // Preserve ggml's CUDA -> HIP -> RPC/Vulkan/CPU registration order. Load
    // only the split modules here, so GGML_BACKEND_PATH is processed once by
    // the usual load-all call. Flattened layouts already contain every module.
    for (const auto& package : g_packages) {
      if (package.dir != path)
        ggml_backend_load(package.file.c_str());
    }
    ggml_backend_load_all_from_path(*path != '\0' ? path : nullptr);
  });
  return ggml_backend_reg_count();
}
