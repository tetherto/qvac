#include "utils.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstring>
#include <iterator>
#include <stdexcept>
#include <string_view>
#include <system_error>
#include <thread>

#if defined(__unix__) || defined(__APPLE__)
#include <unistd.h>
#endif

#include <common/arg.h>
#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama/common/common.h>

#include "addon/BertErrors.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;

std::vector<std::string>
splitLines(const std::string& str, const std::string& separator) {
  std::vector<std::string> lines;
  size_t start = 0;
  size_t end = str.find(separator);

  while (end != std::string::npos) {
    lines.push_back(str.substr(start, end - start));
    start = end + separator.length();
    end = str.find(separator, start);
  }

  lines.push_back(str.substr(start)); // Add the last part

  return lines;
}

void lazyCommonInit() {
  static bool initialized = false;
  if (!initialized) {
    common_init();
    initialized = true;
  }
}

std::unordered_map<std::string, std::string>
extractVerbosityConfig(std::string& config) {
  std::unordered_map<std::string, std::string> configMap;
  int foundVerbosity = -1;
  size_t lineStart = std::string::npos;
  size_t lineEnd = std::string::npos;
  bool hasTrailingNewline = false;

  // Extract substring "verbosity\t{integer}" from config
  size_t pos = config.find("verbosity\t");
  if (pos != std::string::npos) {
    // Find the start of the line (start at the beginning of 'verbosity')
    lineStart = pos;

    size_t start = pos + std::strlen("verbosity\t");
    size_t end = start;
    // Scan digits for integer
    while (end < config.size() &&
           std::isdigit(static_cast<unsigned char>(config[end]))) {
      ++end;
    }
    if (end > start) {
      std::string verbosityStr = config.substr(start, end - start);
      try {
        foundVerbosity = std::stoi(verbosityStr);
      } catch (...) {
        foundVerbosity = -1; // fallback: ignore parse errors
      }

      // Find the end of the line (include newline if present)
      lineEnd = end;
      if (lineEnd < config.size() && config[lineEnd] == '\n') {
        ++lineEnd;
        hasTrailingNewline = true;
      }
    }
  }

  // Set verbosity in config map if found
  if (foundVerbosity >= 0) {
    configMap["verbosity"] = std::to_string(foundVerbosity);

    // Remove the verbosity line from config
    if (lineStart != std::string::npos && lineEnd != std::string::npos) {
      // Only include the preceding newline if there's NO trailing newline
      // This ensures we remove exactly one newline separator
      if (!hasTrailingNewline && lineStart > 0 &&
          config[lineStart - 1] == '\n') {
        lineStart--;
      }
      config.erase(lineStart, lineEnd - lineStart);
    }
  }

  return configMap;
}

std::optional<llama_load_mode>
deprecatedLoadFlagMode(const std::string& flag, const std::string& value) {
  struct DeprecatedLoadFlag {
    std::string_view key;
    bool isPositive;
    bool negatable;
    llama_load_mode enabled;
  };
  static constexpr DeprecatedLoadFlag kDeprecatedLoadFlags[] = {
      {"mmap", true, true, LLAMA_LOAD_MODE_MMAP},
      {"no-mmap", false, true, LLAMA_LOAD_MODE_MMAP},
      {"direct-io", true, true, LLAMA_LOAD_MODE_DIRECT_IO},
      {"no-direct-io", false, true, LLAMA_LOAD_MODE_DIRECT_IO},
      // A valueless flag in llama, so it can only assert itself.
      {"mlock", true, false, LLAMA_LOAD_MODE_MLOCK}};

  const auto* const flagIt =
      std::ranges::find(kDeprecatedLoadFlags, flag, &DeprecatedLoadFlag::key);
  if (flagIt == std::end(kDeprecatedLoadFlags)) {
    return std::nullopt;
  }
  bool requested = true;
  if (!value.empty()) {
    if (common_arg_utils::is_truthy(value)) {
      requested = true;
    } else if (flagIt->negatable && common_arg_utils::is_falsey(value)) {
      requested = false;
    } else {
      throw std::invalid_argument(string_format(
          "unknown value for --%s: '%s'", flag.c_str(), value.c_str()));
    }
  }
  return flagIt->isPositive == requested ? flagIt->enabled
                                         : LLAMA_LOAD_MODE_NONE;
}

const char* loadModeName(llama_load_mode mode) {
  switch (mode) {
  case LLAMA_LOAD_MODE_AUTO:
    return "auto";
  case LLAMA_LOAD_MODE_NONE:
    return "none";
  case LLAMA_LOAD_MODE_MMAP:
    return "mmap";
  case LLAMA_LOAD_MODE_MLOCK:
    return "mlock";
  case LLAMA_LOAD_MODE_MMAP_MLOCK:
    return "mmap+mlock";
  case LLAMA_LOAD_MODE_DIRECT_IO:
    return "dio";
  }
  return "auto";
}

bool isThreadsKey(const std::string& key) {
  return key == "threads" || key == "threads-batch" || key == "threads_batch";
}

namespace {

// CPUs the device has. hardware_concurrency() counts the online ones, which
// Android lowers when it parks cores, so take the configured count when larger.
unsigned cpuCount() {
  unsigned cpus = std::thread::hardware_concurrency();
#if defined(_SC_NPROCESSORS_CONF)
  const long configured = sysconf(_SC_NPROCESSORS_CONF);
  if (configured > 0) {
    cpus = std::max(cpus, static_cast<unsigned>(configured));
  }
#endif
  return cpus;
}

} // namespace

// A whole number, at most the CPU count; 0 or below means every CPU. More
// threads than CPUs only slows a pass down, because ggml's workers wait on
// spinning barriers: on 10 CPUs, 16 threads took about 11x as long as 10, and
// 128 did not finish within a minute.
void checkThreads(const std::string& key, const std::string& value) {
  long long threads = 0;
  const char* end = value.data() + value.size();
  const auto [ptr, ec] = std::from_chars(value.data(), end, threads);
  if (ec == std::errc::result_out_of_range) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format(
            "%s: '%s' is out of range: '%s'",
            __func__,
            key.c_str(),
            value.c_str()));
  }
  if (ec != std::errc() || ptr != end) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format(
            "%s: '%s' must be a whole number, got '%s'",
            __func__,
            key.c_str(),
            value.c_str()));
  }
  const unsigned cpus = cpuCount();
  if (threads > 0 && cpus > 0 && threads > static_cast<long long>(cpus)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format(
            "%s: '%s' is %lld, but this device has %u CPUs; use at most %u, "
            "or 0 for all of them",
            __func__,
            key.c_str(),
            threads,
            cpus,
            cpus));
  }
}

void checkLoadOptions(
    const std::unordered_map<std::string, std::string>& config,
    const std::unordered_set<std::string>& allowed, const char* caller,
    const char* model, const char* accepted) {
  for (const auto& [key, value] : config) {
    if (!allowed.contains(key)) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(InvalidConfiguration),
          string_format(
              "%s: '%s' is not a %s load option; accepted: %s",
              caller,
              key.c_str(),
              model,
              accepted));
    }
    if (isThreadsKey(key)) {
      checkThreads(key, value);
    }
  }
}

int32_t unifiedSequenceLimit(const common_params& params) {
  // A causal context caps its batch at the context size.
  int64_t tokens = params.n_batch;
  if (params.n_ctx > 0) {
    tokens = std::min<int64_t>(tokens, params.n_ctx);
  }
  return static_cast<int32_t>(std::max<int64_t>(
      1,
      std::min<int64_t>(
          static_cast<int64_t>(llama_max_parallel_sequences()), tokens)));
}

void configureSinglePassRankContext(common_params& params) {
  params.embedding = true;
  params.pooling_type = LLAMA_POOLING_TYPE_RANK;
  params.n_ctx = params.n_batch;
  params.n_ubatch = params.n_batch;
  params.n_parallel = unifiedSequenceLimit(params);
  params.kv_unified = true;
}

void abortDecodeWhen(llama_context* ctx, const std::atomic<bool>& flag) {
  llama_set_abort_callback(
      ctx,
      [](void* data) -> bool {
        return static_cast<const std::atomic<bool>*>(data)->load();
      },
      const_cast<std::atomic<bool>*>(&flag));
}
