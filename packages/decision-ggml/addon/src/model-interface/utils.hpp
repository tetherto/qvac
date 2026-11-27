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

/// @brief Empty when @p loaded, the port the loaded @qvac/fabric runtime is
/// built from (qvac_fabric_port_version()), is @p built, the port this addon's
/// server-context comes from; otherwise why the addon cannot load. The two are
/// compared exactly: server-context's inlined libcommon code must match the
/// runtime's.
std::string fabricPortMismatch(const char* loaded, const char* built);
