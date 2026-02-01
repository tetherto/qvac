#include "utils.h"

#include <cctype>
#include <cstring>
#include <stdexcept>
#include <string_view>

#include <common/common.h>
#include <llama/common/common.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/BertErrors.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;

std::vector<std::string> splitLines(const std::string &str,
                                    const std::string &separator) {
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
