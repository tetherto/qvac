#pragma once

#include <filesystem>
#include <string>
#include <system_error>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#ifndef QVAC_ADDON_MODULE_NAME
#error "QVAC_ADDON_MODULE_NAME must name the module (qvac__tts-ggml-<suffix>)"
#endif

namespace qvac::ttsggml {

// Internal linkage throughout: the address handed to the loader must be inside
// the module that compiled it.
namespace {

inline std::filesystem::path modulePath() {
#if defined(_WIN32)
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(&modulePath),
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
      return std::filesystem::path(buffer);
    }
    buffer.resize(buffer.size() * 2);
  }
#else
  Dl_info info{};
  if (dladdr(reinterpret_cast<void*>(&modulePath), &info) == 0 ||
      info.dli_fname == nullptr) {
    return {};
  }
  return std::filesystem::path(info.dli_fname);
#endif
}

// Where this module's dynamically loaded ggml backends are: <module dir>/<module
// name> as installed in prebuilds/<host>/, else the module's own directory,
// where bare-link puts them in a mobile app. Asked of the loader because the
// module is wherever the platform package, bare-link or the APK put it. Empty
// when the loader cannot say, which leaves ggml's default search.
inline std::filesystem::path defaultBackendsDir() {
  static const std::filesystem::path dir = [] {
    const std::filesystem::path self = modulePath();
    if (self.empty()) return std::filesystem::path();
    const std::filesystem::path parent = self.parent_path();
    std::error_code ec;
    const std::filesystem::path nested = parent / QVAC_ADDON_MODULE_NAME;
    if (std::filesystem::is_directory(nested, ec)) return nested;
    return parent;
  }();
  return dir;
}

// A configured directory is used as given; otherwise the module's own.
inline std::filesystem::path resolveBackendsDir(const std::string& configured) {
  if (!configured.empty()) return std::filesystem::path(configured);
  return defaultBackendsDir();
}

}  // namespace

}  // namespace qvac::ttsggml
