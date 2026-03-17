#pragma once

#include <mutex>
#include <string>

/**
 * Lazy initialization class for llama backend.
 * Ensures backend is initialized only once (even when instantiating multiple
 * LlamaModel objects) and tracks the backends directory.
 */
class LlamaLazyInitializeBackend {
public:
  /**
   * Initialize the backend lazily.
   * @param backendsDir - path to the backends directory (optional).
   *                      If empty, uses default backend loading.
   * @return true if initialization was successful, false if already
   * initialized.
   */
  static bool initialize(const std::string& backendsDir = "");

  /**
   * Increment the reference count.
   */
  static void incrementRefCount();

  /**
   * Decrement the reference count. When it reaches zero, explicitly unloads
   * all dynamically-loaded backends and frees the llama backend.
   */
  static void decrementRefCount();

  /**
   * Explicitly shut down the backend: unload all dynamically-loaded GPU
   * backend libraries (triggering their destructors while ggml state is
   * still alive), then free the llama backend. This prevents SIGSEGV at
   * process exit from static destructor ordering issues.
   *
   * Called once at process exit from the JS layer, before the runtime
   * unloads the addon. Must not be called while models are still active.
   */
  static void shutdownBackends();

private:
  static std::mutex g_initMutex;
  static bool g_initialized;
  static std::string g_recordedBackendsDir;
  static int g_refCount;
};

/**
 * RAII handle for backend initialization.
 * Increments reference count on construction and decrements on destruction.
 * When the last handle is destroyed, the backend is freed.
 */
class LlamaBackendsHandle {
public:
  /**
   * Construct a handle and increment the reference count.
   * @param backendsDir - optional path to the backends directory.
   */
  explicit LlamaBackendsHandle(const std::string& backendsDir = "");

  /**
   * Destructor decrements reference count and may free backend.
   */
  ~LlamaBackendsHandle();

  // Non-copyable
  LlamaBackendsHandle(const LlamaBackendsHandle&) = delete;
  LlamaBackendsHandle& operator=(const LlamaBackendsHandle&) = delete;

  // Movable
  LlamaBackendsHandle(LlamaBackendsHandle&&) noexcept;
  LlamaBackendsHandle& operator=(LlamaBackendsHandle&&) noexcept;

private:
  bool ownsHandle_;
};
