#include <cstdint>
#include <cstdio>
#include <string>

#include <bare.h>
#include <js.h>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>

#include "fit/FitParams.hpp"

#ifdef _WIN32
#include <windows.h>

#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <exception>

namespace {

// DIAGNOSTIC ONLY (temporary): llama_params_fit terminates the process on the
// Windows-Vulkan path with exit code 1 and no output. This captures *whatever*
// the mechanism is: a vectored handler prints every SEH exception code + the
// faulting instruction's module (before the SEH chain), and terminate/abort
// hooks catch a C++ std::terminate or abort() that a plain SEH handler misses.
void printModuleOf(const char* label, void* addr) {
  HMODULE mod = nullptr;
  char path[MAX_PATH] = {0};
  if (GetModuleHandleExA(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCSTR>(addr),
          &mod) != 0 &&
      GetModuleFileNameA(mod, path, MAX_PATH) != 0) {
    std::fprintf(
        stderr,
        "[fit-llamacpp]   %s %p  %s+0x%llx\n",
        label,
        addr,
        path,
        static_cast<unsigned long long>(
            reinterpret_cast<uintptr_t>(addr) -
            reinterpret_cast<uintptr_t>(mod)));
  } else {
    std::fprintf(
        stderr, "[fit-llamacpp]   %s %p  <unknown module>\n", label, addr);
  }
}

LONG CALLBACK fitCrashHandler(EXCEPTION_POINTERS* info) {
  const DWORD code = info->ExceptionRecord->ExceptionCode;
  // 0xE06D7363 == a C++ throw (MSVC); it's noise unless it's the last thing.
  std::fprintf(
      stderr,
      "[fit-llamacpp] SEH exception 0x%08lx (flags=0x%lx)\n",
      static_cast<unsigned long>(code),
      static_cast<unsigned long>(info->ExceptionRecord->ExceptionFlags));
  printModuleOf("at", info->ExceptionRecord->ExceptionAddress);
  void* frames[24] = {nullptr};  // NOLINT
  const USHORT n = CaptureStackBackTrace(0, 24, frames, nullptr);  // NOLINT
  for (USHORT i = 0; i < n; ++i) {
    char lbl[8] = {0};
    std::snprintf(lbl, sizeof(lbl), "#%02u", i);
    printModuleOf(lbl, frames[i]);
  }
  std::fflush(stderr);
  return EXCEPTION_CONTINUE_SEARCH;
}

[[noreturn]] void fitTerminateHandler() {
  std::fprintf(stderr, "[fit-llamacpp] std::terminate() called\n");
  std::fflush(stderr);
  std::abort();
}

void fitAbortHandler(int /*sig*/) {
  std::fprintf(stderr, "[fit-llamacpp] SIGABRT / abort()\n");
  std::fflush(stderr);
}

void installCrashHandler() {
  static bool installed = false;
  if (!installed) {
    AddVectoredExceptionHandler(1, fitCrashHandler);
    std::set_terminate(fitTerminateHandler);
    std::signal(SIGABRT, fitAbortHandler);
    installed = true;
  }
}

}  // namespace
#else
namespace {
inline void installCrashHandler() {}
}  // namespace
#endif

namespace fit_llamacpp::bindings {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace jsu = qvac_lib_inference_addon_cpp::js;

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

/// `paramsFit(config)` — synchronous memory-fit preflight. Reads a plain config
/// object, runs `llama_params_fit` (no weights are loaded), and returns the
/// fitted "load plan" as a JS object. Throwing goes through `JSCATCH`, which
/// converts C++ exceptions into JS errors.
inline js_value_t* paramsFit(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  auto config = args.getJsObject(0, "config");

  FitRequest req;
  req.modelPath =
      config.getProperty<jsu::String>(env, "modelPath").as<std::string>(env);
  if (req.modelPath.empty()) {
    throw StatusError(
        InvalidArgument,
        "fit-llamacpp: 'modelPath' is required and must be a non-empty string "
        "pointing at the GGUF weights file");
  }

  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nCtx")) {
    req.nCtx = v->as<uint32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nCtxMin")) {
    req.nCtxMin = v->as<uint32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nBatch")) {
    req.nBatch = v->as<uint32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nUbatch")) {
    req.nUbatch = v->as<uint32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nGpuLayers")) {
    req.nGpuLayers = v->as<int32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "marginMiB")) {
    req.marginMiB = v->as<uint32_t>(env);
  }

  const FitResult res = runFit(req);

  auto out = jsu::Object::create(env);
  out.setProperty(
      env, "status", jsu::Number::create(env, static_cast<int32_t>(res.status)));
  out.setProperty(env, "fits", jsu::Boolean::create(env, res.fits));
  out.setProperty(env, "nGpuLayers", jsu::Number::create(env, res.nGpuLayers));
  out.setProperty(env, "nCtx", jsu::Number::create(env, res.nCtx));
  out.setProperty(env, "nBatch", jsu::Number::create(env, res.nBatch));
  out.setProperty(env, "nUbatch", jsu::Number::create(env, res.nUbatch));
  out.setProperty(
      env,
      "maxDevices",
      jsu::Number::create(env, static_cast<uint32_t>(res.maxDevices)));

  auto split = jsu::Array::create(env);
  for (size_t i = 0; i < res.tensorSplit.size(); ++i) {
    split.set(
        env, i, jsu::Number::create(env, static_cast<double>(res.tensorSplit[i])));
  }
  out.setProperty(env, "tensorSplit", split);

  return out;
}
JSCATCH

}  // namespace fit_llamacpp::bindings

// NOLINTNEXTLINE(readability-identifier-naming)
js_value_t* fit_llamacpp_exports(js_env_t* env, js_value_t* exports) {
  // DIAGNOSTIC (temporary): unbuffer stderr so native llama/ggml logs survive a
  // hard crash (Windows CI pipes stderr => block-buffered => lost on crash).
  std::setvbuf(stderr, nullptr, _IONBF, 0);
  std::fprintf(stderr, "[fit-diag] module loaded, diagnostics active\n");
  installCrashHandler();  // DIAGNOSTIC (temporary): capture Windows crash stack

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn)                                                            \
  {                                                                            \
    js_value_t* val;                                                           \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("paramsFit", fit_llamacpp::bindings::paramsFit)

#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(fit_llamacpp, fit_llamacpp_exports)
