#pragma once

#include <atomic>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <js.h>

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

/// Resolves the `id` of each batch item: reads the caller-provided id,
/// mints `batch-N` when missing, rejects empty strings and duplicates,
/// and stashes the final id list for transport back to JS. One instance
/// per `parseBatchInputs` call. `mint()`'s counter is `std::atomic` so it
/// stays correct even if admissions ever stop being serialized.
class JsBatchIds {
public:
  /// Wipe per-batch state. Call once at the start of every batch parse.
  void reset(uint32_t batchSize) {
    seen_.clear();
    ids_.clear();
    ids_.reserve(batchSize);
  }

  /// Pull `item.id` (optional), mint when missing, enforce non-empty
  /// + uniqueness, record in insertion order. Returns the resolved id.
  const std::string& resolveAndTrack(js_env_t* env, js::Object& item) {
    using qvac_errors::StatusError;
    using qvac_errors::general_error::InvalidArgument;

    std::optional<std::string> providedId =
        item.getOptionalPropertyAs<js::String, std::string>(env, "id");
    std::string pid;
    if (providedId.has_value()) {
      pid = std::move(*providedId);
      if (pid.empty()) {
        throw StatusError(
            InvalidArgument,
            "Batch prompt id must be a non-empty string when provided");
      }
    } else {
      pid = mint();
    }
    if (!seen_.insert(pid).second) {
      throw StatusError(InvalidArgument, "Duplicate batch prompt id: " + pid);
    }
    ids_.push_back(std::move(pid));
    return ids_.back();
  }

  /// Resolved ids in insertion order.
  [[nodiscard]] const std::vector<std::string>& ids() const { return ids_; }

  /// Materialize a JS string array mirroring `ids()` for return to JS.
  [[nodiscard]] js::Array toJsArray(js_env_t* env) const {
    js::Array out = js::Array::create(env, ids_.size());
    for (uint32_t i = 0; i < ids_.size(); ++i) {
      out.set(env, i, js::String::create(env, std::string_view{ids_[i]}));
    }
    return out;
  }

private:
  /// Process-wide monotonic counter for auto-minted ids. Skipped numbers
  /// (on rejected/failed batches) are harmless: ids only need uniqueness
  /// within an accepted batch, enforced per-call by `resolveAndTrack`.
  static std::string mint() {
    static std::atomic<uint64_t> next{0};
    return "batch-" + std::to_string(next.fetch_add(1) + 1);
  }

  // `std::set` (RB-tree) beats `unordered_set` at the small batch sizes
  // seen here (~tens of items): string compares on short ids are cheaper
  // than hashing, and there is no per-bucket allocation.
  std::set<std::string> seen_;
  std::vector<std::string> ids_;
};

} // namespace qvac_lib_inference_addon_llama
