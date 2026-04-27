#pragma once

#include <mutex>
#include <string>

/**
 * Lazy initialization class for NMT GGML backend.
 * Ensures backend is initialized only once (even when instantiating multiple
 * TranslationModel objects) and tracks the backends directory.
 */
class NmtLazyInitializeBackend {
public:
  /**
   * Initialize the backend lazily.
   * @param backendsDir - path to the backends directory (optional).
   *                      If empty, uses default backend loading.
   * @param openclCacheDir - writable directory for OpenCL kernel cache
   * (optional).
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
   * Decrement the reference count and reset state if count reaches zero.
   */
  static void decrementRefCount();

private:
  static std::mutex g_initMutex;
  static bool g_initialized;
  static std::string g_recordedBackendsDir;
  static int g_refCount;
};

/**
 * RAII handle for NMT backend initialization.
 * Increments reference count on construction and decrements on destruction.
 * When the last handle is destroyed, the backend state is reset.
 */
class NmtBackendsHandle {
public:
  /**
   * No-op default constructor (does not own a handle).
   */
  NmtBackendsHandle() : ownsHandle_(false) {}

  /**
   * Construct a handle and increment the reference count.
   * @param backendsDir - optional path to the backends directory.
   * @param openclCacheDir - writable directory for OpenCL kernel cache
   * (optional).
   */
  explicit NmtBackendsHandle(
      const std::string& backendsDir, const std::string& openclCacheDir = "");

  /**
   * Destructor decrements reference count and may reset backend state.
   */
  ~NmtBackendsHandle();

  // Non-copyable
  NmtBackendsHandle(const NmtBackendsHandle&) = delete;
  NmtBackendsHandle& operator=(const NmtBackendsHandle&) = delete;

  // Movable
  NmtBackendsHandle(NmtBackendsHandle&&) noexcept;
  NmtBackendsHandle& operator=(NmtBackendsHandle&&) noexcept;

private:
  bool ownsHandle_;
};
