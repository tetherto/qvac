#pragma once

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>

#include <gtest/gtest.h>

#include "model-interface/ModelMetadata.hpp"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

namespace test_common {

inline double getStatValue(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  for (const auto& stat : stats) {
    if (stat.first == key) {
      return std::visit(
          [](const auto& value) -> double {
            if constexpr (std::is_same_v<
                              std::decay_t<decltype(value)>,
                              double>) {
              return value;
            } else if constexpr (std::is_same_v<
                                     std::decay_t<decltype(value)>,
                                     int64_t>) {
              return static_cast<double>(value);
            } else {
              return 0.0;
            }
          },
          stat.second);
    }
  }
  return 0.0;
}

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

/**
 * Encapsulates discovery and guard logic for a single optional test model,
 * covering both single-file and sharded GGUF layouts.
 *
 * Construction resolves the path once: it checks @p envVar first, then
 * looks for @p filename under BaseTestModelPath. When @p isSharded is true
 * the shard list is also expanded via GGUFShards::expandGGUFIntoShards().
 * Callers that need absolute shard paths should call
 * LlamaModel::resolveShardPaths(model.shards, model.path) after construction.
 *
 * Use REQUIRE_MODEL() in the test body to skip or fail automatically when
 * the model is absent.
 *
 * Single-file example:
 *   TestModelPath m("my-model-Q4_0.gguf", "MY_MODEL_PATH",
 *                   TestModelPath::OnMissing::Skip,
 *                   "https://huggingface.co/...");
 *
 * Sharded example:
 *   TestModelPath m("my-model-00001-of-00008.gguf", "MY_SHARD_PATH",
 *                   TestModelPath::OnMissing::Skip, "https://...", true);
 *   LlamaModel::resolveShardPaths(m.shards, m.path);  // resolve absolute paths
 */
struct TestModelPath {
  enum class OnMissing { Fail, Skip };

  std::string path;     ///< Resolved absolute path to the first (or only) file.
  std::string filename; ///< Bare .gguf filename used in diagnostic messages.
  std::string envVar;   ///< Env-var name shown in the diagnostic (may be "").
  std::string hfUrl;   ///< HuggingFace URL shown in the diagnostic (may be "").
  OnMissing onMissing; ///< Whether to FAIL or GTEST_SKIP when absent.
  bool isSharded;      ///< True when the model is split across multiple files.
  GGUFShards shards;   ///< Populated (without absolute paths) when isSharded.

  TestModelPath() : onMissing(OnMissing::Skip), isSharded(false) {}

  TestModelPath(
      const char* filename, const char* envVar, OnMissing onMissing,
      const char* hfUrl = "", bool isSharded = false)
      : filename(filename), envVar(envVar ? envVar : ""), hfUrl(hfUrl),
        onMissing(onMissing), isSharded(isSharded) {
    const char* env = envVar ? std::getenv(envVar) : nullptr;
    if (env && fs::exists(env)) {
      path = env;
    } else {
      std::string p = BaseTestModelPath::get(filename);
      if (fs::exists(p))
        path = p;
    }
    if (isSharded && !path.empty())
      shards = GGUFShards::expandGGUFIntoShards(path);
  }

  /**
   * Returns true when the model is ready to use.
   * For sharded models this requires at least one shard to have been
   * resolved; for single-file models a non-empty path suffices.
   */
  [[nodiscard]] bool found() const {
    return isSharded ? !shards.gguf_files.empty() : !path.empty();
  }

  [[nodiscard]] std::string missingMessage() const {
    std::string msg = filename + " not found";
    if (!envVar.empty())
      msg += " (" + envVar + " or models/unit-test)";
    else
      msg += " in models/unit-test";
    if (!hfUrl.empty())
      msg += "; see " + hfUrl;
    return msg;
  }
};

inline fs::path getTestBackendsDir() {
#ifdef TEST_BINARY_DIR
  return fs::path(TEST_BINARY_DIR);
#else
  return fs::current_path() / "build" / "test" / "unit";
#endif
}

class MockModelMetaData : public ModelMetaData {
public:
  MockModelMetaData(bool oneBitQuant, std::string arch)
      : oneBitQuant_(oneBitQuant), arch_(std::move(arch)) {}

  [[nodiscard]] bool hasOneBitQuantization() const override {
    return oneBitQuant_;
  }
  std::optional<std::string> tryGetString(const char* key) const override {
    if (std::string(key) == "general.architecture")
      return arch_;
    return std::nullopt;
  }

private:
  bool oneBitQuant_;
  std::string arch_;
};

inline std::unique_ptr<std::basic_streambuf<char>>
readFileToStreambufBinary(const std::string& path) {
  auto buf = std::make_unique<std::filebuf>();
  if (!buf->open(path, std::ios::binary | std::ios::in)) {
    return nullptr;
  }
  return buf;
}

} // namespace test_common

/**
 * Guard a test against a missing model: emits GTEST_SKIP() or FAIL()
 * (as configured on the model) when the file was not found.
 *
 * Must be called directly from the test function body, not from a helper,
 * so that GTEST_SKIP / FAIL return from the correct stack frame.
 */
#define REQUIRE_MODEL(m)                                                       \
  if (!(m).found()) {                                                          \
    if ((m).onMissing == ::test_common::TestModelPath::OnMissing::Skip)        \
      GTEST_SKIP() << (m).missingMessage();                                    \
    FAIL() << (m).missingMessage();                                            \
  }                                                                            \
  static_assert(true, "")
