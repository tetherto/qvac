#pragma once

#include <atomic>
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
   * Atomically initialize (if not already) and increment the reference
   * count under a single g_initMutex acquisition. NmtBackendsHandle uses
   * this to avoid the TOCTOU window where a racing decrement could land
   * between the initialize() unlock and incrementRefCount() lock and
   * incorrectly tear the backend down before the new handle takes its
   * reference.
   * @return true if initialization was performed by this call, false if
   *         the backend was already initialized.
   */
  static bool initializeAndRef(
      const std::string& backendsDir = "",
      const std::string& openclCacheDir = "");

  /**
   * Decrement the reference count and reset state if count reaches zero.
   */
  static void decrementRefCount();

private:
  /**
   * Internal helper: performs initialization assuming g_initMutex is
   * already held by the caller. Returns true if initialization was
   * performed by this call, false if the backend was already initialized.
   */
  static bool initializeLocked(
      const std::string& backendsDir, const std::string& openclCacheDir);

  static std::mutex g_initMutex;
  static bool g_initialized;
  static std::string g_recordedBackendsDir;
  static std::string g_recordedOpenclCacheDir;
  static std::string g_recordedOpenclCacheDirInput;
  static int g_refCount;
  static std::atomic<bool> g_backendsLoaded;
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
  NmtBackendsHandle(NmtBackendsHandle&& other) noexcept;
  NmtBackendsHandle& operator=(NmtBackendsHandle&& other) noexcept;

private:
  bool ownsHandle_;
};
