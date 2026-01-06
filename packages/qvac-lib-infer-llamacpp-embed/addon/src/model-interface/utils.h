#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <llama.h>

std::vector<std::string> splitLines(const std::string &str,
                                    const std::string &separator = "\n");

/// @brief Initializes common library only on first call. Can be called
/// from all modules that depend on the common library and will only be
/// initialized once.
/// @note Not thread safe.
void lazyCommonInit();

/// @brief Extracts verbosity level from config string and removes it from the
/// string
/// @param config The config string to parse and modify (format:
/// "verbosity\t{integer}")
/// @return A map with "verbosity" key if found, empty map otherwise
std::unordered_map<std::string, std::string>
extractVerbosityConfig(std::string& config);
