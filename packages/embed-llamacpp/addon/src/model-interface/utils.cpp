#include "utils.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <iterator>
#include <stdexcept>
#include <string_view>

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
