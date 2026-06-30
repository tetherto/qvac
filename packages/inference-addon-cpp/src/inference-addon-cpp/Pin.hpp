#pragma once

// Pin the current addon's shared library in memory so it is never unmapped.
//
// Why this is needed:
//   A bare Worklet is a V8 isolate + its own thread that dlopen()s native
//   addons (`.bare` shared libraries) into itself. `worklet.terminate()` tears
//   that down and dlclose()s the addons. Model backends (ggml, OpenMP, etc.)
//   register thread-local / pthread_key_t destructors whose code lives inside
//   the addon `.so`. On Android (bionic) dlclose() UNMAPS that code, but those
//   destructors are still registered, so when a thread later exits the runtime
//   jumps into the now-unmapped code and the process aborts (SIGSEGV/abort).
//   On iOS dlclose() is effectively a no-op (the library stays mapped), which
//   is why terminate() is safe there.
//
//   bare deliberately keeps unloading addons (otherwise every addon would
//   leak), so an addon that relies on thread destructors must pin itself.
//   Taking an RTLD_NOLOAD | RTLD_NODELETE reference to our own library keeps
//   only the (small, fixed) code mapping resident for the process lifetime —
//   the isolate + thread are still fully torn down, which is where the large
//   per-worklet memory actually lives. This matches iOS behaviour and is the
//   same approach used by bare-crypto and bare-tls:
//   https://github.com/holepunchto/bare-crypto/blob/a01097c/binding.c
//
// Validated on-device (Pixel 10 Pro XL, Android, bionic): an addon registering
// a pthread_key destructor crashes (SIGSEGV) on dlclose() without the pin, and
// survives with it.

#include <atomic>

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

namespace qvac_lib_inference_addon_cpp {

// Pin the addon `.so`/`.dll` that this function is compiled into. Safe to call
// repeatedly and concurrently; the work is done once per loaded addon. `dladdr`
// resolves to the calling addon's own library (addons are loaded RTLD_LOCAL, so
// the symbol is not interposed), so each addon pins itself.
#if !defined(_WIN32)
__attribute__((visibility("hidden")))
#endif
inline void
pinAddon() {
  // Atomic so multiple Bare worklet threads creating instances concurrently
  // can't race the guard and both fall through to pin. The first thread to
  // exchange in `true` does the work; everyone else returns.
  static std::atomic<bool> pinned{false};
  if (pinned.exchange(true)) {
    return;
  }

#if defined(_WIN32)
  HMODULE module = nullptr;
  GetModuleHandleExA(
      GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCSTR>(&pinAddon),
      &module);
#else
  Dl_info info;
  if (dladdr(reinterpret_cast<void*>(&pinAddon), &info) != 0 &&
      info.dli_fname != nullptr) {
    dlopen(info.dli_fname, RTLD_LAZY | RTLD_NOLOAD | RTLD_NODELETE);
  }
#endif
}

} // namespace qvac_lib_inference_addon_cpp
