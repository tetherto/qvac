#pragma once

#include <mutex>
#include <string>

// Lazy initialization and reference-count tracking for GGML backends used by
// ocr-ggml Pipeline instances. Mirrors the LlamaLazyInitializeBackend /
// LlamaBackendsHandle pattern from llm-llamacpp.
//
// The first Pipeline construction loads all GGML backend .so files and
// installs log / abort callbacks. Subsequent constructions skip the load and
// only bump the reference count. The backends are never explicitly unloaded
// (no ggml equivalent of llama_backend_free) — they remain resident for the
// process lifetime — so decrementRefCount only tracks liveness, not
// deallocation.

// NOLINTBEGIN(readability-identifier-naming)

class OcrLazyInitializeBackend {
public:
  // Initialize GGML backends lazily. Called once per process regardless of how
  // many Pipeline objects exist.
  // @param backendsDir  Prebuilds root passed by the JS caller; empty falls
  //                     back to ggml_backend_load_all().
  // @return true on first initialization, false if already initialized.
  static bool initialize(const std::string& backendsDir = "");

  static void incrementRefCount();

  // Decrements the reference count. Because GGML dynamically-loaded backends
  // have no process-scoped free, reaching zero only resets the internal state
  // so that a subsequent initialize() call is a no-op (backends stay loaded).
  static void decrementRefCount();

private:
  static std::mutex g_initMutex;
  static bool g_initialized;
  static std::string g_recordedBackendsDir;
  static int g_refCount;
};

// RAII handle for GGML backend initialization.  Each Pipeline holds one;
// construction triggers initialize() + incrementRefCount(), destruction
// decrements the count.  Non-copyable, movable.
class OcrBackendsHandle {
public:
  explicit OcrBackendsHandle(const std::string& backendsDir = "");
  ~OcrBackendsHandle();

  OcrBackendsHandle(const OcrBackendsHandle&) = delete;
  OcrBackendsHandle& operator=(const OcrBackendsHandle&) = delete;

  OcrBackendsHandle(OcrBackendsHandle&&) noexcept;
  OcrBackendsHandle& operator=(OcrBackendsHandle&&) noexcept;

private:
  bool ownsHandle_;
};

// NOLINTEND(readability-identifier-naming)
