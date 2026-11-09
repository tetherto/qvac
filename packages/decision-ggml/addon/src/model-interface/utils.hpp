#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <llama.h>

// llama's type, named by llama.
// NOLINTNEXTLINE(readability-identifier-naming)
struct common_params;

std::vector<std::string>
splitLines(const std::string& str, const std::string& separator = "\n");

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

/// @brief Load mode selected by one of llama's deprecated load flags (mmap,
/// no-mmap, direct-io, no-direct-io, mlock), which fabric's argument table no
/// longer has.
/// @return std::nullopt for any other key
/// @throws std::invalid_argument for a value the flag does not take
std::optional<llama_load_mode>
deprecatedLoadFlagMode(const std::string& flag, const std::string& value);

/// @brief The `--load-mode` value that selects `mode`.
const char* loadModeName(llama_load_mode mode);

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

/// @brief The sequence limit for a unified-cache context: one sequence per
/// token the batch can hold, at most llama's maximum. llama aborts a context
/// whose sequence limit exceeds its batch, and rejects a batch whose sequence
/// ids reach the limit.
int32_t unifiedSequenceLimit(const common_params& params);

/// @brief A context that reads RANK pooling in one pass per batch, as
/// llama-laya and llama-server's --reranking set it up: no KV cache is kept
/// between passes, so the context only has to hold one batch, every sequence
/// must fit in one ubatch for RANK pooling, and a batch holds at most one
/// sequence per token.
void configureSinglePassRankContext(common_params& params);

/// @brief Aborts a pass in llama_decode once @p flag is set. @p flag must
/// outlive @p ctx, so a temporary is rejected at compile time.
void abortDecodeWhen(llama_context* ctx, const std::atomic<bool>& flag);
void abortDecodeWhen(llama_context* ctx, const std::atomic<bool>&& flag) =
    delete;
