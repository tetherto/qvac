#pragma once

#include <string>
#include <unordered_map>
#include <unordered_set>

/// @brief Whether @p key sets a CPU thread count (`threads`, `threads-batch`).
bool isThreadsKey(const std::string& key);

/// @brief Throws InvalidConfiguration unless @p value is a whole number of at
/// most the device's CPU count; 0 or below means every CPU.
void checkThreads(const std::string& key, const std::string& value);

/// @brief Throws InvalidConfiguration for a key of @p config outside
/// @p allowed, as "<caller>: '<key>' is not a <model> load option; accepted:
/// <accepted>", and checks thread counts with checkThreads.
void checkLoadOptions(
    const std::unordered_map<std::string, std::string>& config,
    const std::unordered_set<std::string>& allowed, const char* caller,
    const char* model, const char* accepted);
