#pragma once

#include <filesystem>
#include <string>

namespace test_common {

/**
 * Get the appropriate device string for the current platform.
 * Uses CPU on Darwin x64 (Intel Mac) to avoid GPU initialization issues.
 * GPU backend initialization can hang on Intel Macs.
 *
 * @return "cpu" on Darwin x64, "gpu" otherwise
 */
inline const char* getTestDevice() {
#if defined(__APPLE__) && defined(__x86_64__)
  return "cpu";
#else
  return "gpu";
#endif
}

/**
 * Get the appropriate gpu_layers value for the current platform.
 * Uses 0 on Darwin x64 (Intel Mac) when using CPU to avoid GPU-related issues.
 *
 * @return "0" on Darwin x64, "99" otherwise
 */
inline const char* getTestGpuLayers() {
#if defined(__APPLE__) && defined(__x86_64__)
  return "0";
#else
  return "99";
#endif
}

namespace fs = std::filesystem;

/**
 * Reusable base path for unit-test models (e.g. models/unit-test).
 * Use get() for the default model path, or get("filename.gguf") for a
 * specific file under the base.
 */
struct BaseTestModelPath {
  /** Base directory for unit-test models. */
  static fs::path path() {
    if (fs::exists(fs::path{"../../../models/unit-test"})) {
      return fs::path{"../../../models/unit-test"};
    }
    return fs::path{"models/unit-test"};
  }

  /**
   * Default model path: Llama-3.2-1B-Instruct-Q4_0.gguf if present,
   * else test_model.gguf, else "Llama-3.2-1B-Instruct-Q4_0.gguf".
   */
  static std::string get() {
    fs::path base = path();
    fs::path p = base / "Llama-3.2-1B-Instruct-Q4_0.gguf";
    if (fs::exists(p))
      return p.string();
    p = base / "test_model.gguf";
    if (fs::exists(p))
      return p.string();
    return "Llama-3.2-1B-Instruct-Q4_0.gguf";
  }

  /**
   * Default first shard path for split models.
   * Uses Llama-3.2-1B-Instruct-Q4_0-00001-of-00008.gguf under the base dir.
   * https://huggingface.co/jmb95/Llama-3.2-1B-Instruct-Q4_0-sharded
   */
  static std::string getSharded() {
    fs::path p = path() / "Llama-3.2-1B-Instruct-Q4_0-00001-of-00008.gguf";
    if (fs::exists(p))
      return p.string();
    return "Llama-3.2-1B-Instruct-Q4_0-00001-of-00008.gguf";
  }

  /**
   * Path for a specific filename under the base. If the file exists, returns
   * its full path; otherwise returns the filename only (for clearer errors).
   */
  static std::string get(const char* filename) {
    fs::path p = path() / filename;
    if (fs::exists(p))
      return p.string();
    return filename;
  }

  /**
   * Path for a preferred filename with fallback. Tries preferred then fallback
   * under the base; returns full path if either exists, else preferred.
   */
  static std::string get(const char* preferred, const char* fallback) {
    fs::path base = path();
    if (fs::exists(base / preferred))
      return (base / preferred).string();
    if (fs::exists(base / fallback))
      return (base / fallback).string();
    return preferred;
  }
};

} // namespace test_common
