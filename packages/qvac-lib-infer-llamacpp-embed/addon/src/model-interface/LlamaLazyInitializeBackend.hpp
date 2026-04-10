#pragma once

#include <mutex>
#include <string>

/**
 * Lazy initialization class for llama backend.
 * Ensures backend is initialized only once (even when instantiating multiple
 * BertModel objects) and tracks the backends directory.
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
  static bool initialize(
      const std::string& backendsDir = "",
      const std::string& openclCacheDir = "");

  /**
   * Increment the reference count.
   */
  static void incrementRefCount();

  /**
   * Decrement the reference count and free backend if count reaches zero.
   */
  static void decrementRefCount();

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
  explicit LlamaBackendsHandle(
      const std::string& backendsDir = "",
      const std::string& openclCacheDir = "");

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
