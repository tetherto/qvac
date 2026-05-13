#pragma once

#include <atomic>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include <js.h>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

/// Per-call helper that resolves the `id` field of each batch item:
/// reads the caller-provided id, mints `batch-N` when missing, rejects
/// empty strings and duplicates within the batch, and stashes the final
/// id list for transport back to JS.
///
/// One instance per `parseBatchInputs` call; never reused across calls.
/// All instance state lives in `seen_` / `ids_` and is bounded by the
/// current batch size, so it cannot grow across calls.
///
/// Threading: the JS entrypoint that drives this is single-threaded for
/// the addon and the job runner serializes admissions, so only one
/// batch is in flight at a time. The shared `mint()` counter is the one
/// piece of cross-call state and is `std::atomic` so it is safe even if
/// that invariant ever changes.
class JsBatchIds {
public:
  /// Wipe per-batch state. Call once at the start of every batch parse.
  /// `ids_` keeps its underlying vector capacity across calls; `seen_`
  /// nodes are released by `std::set::clear()` (no node pooling), but
  /// the set object itself avoids reconstruction.
  void reset(uint32_t batchSize) {
    seen_.clear();
    ids_.clear();
    ids_.reserve(batchSize);
  }

  /// Pull `item.id` (optional), mint when missing, enforce non-empty
  /// + uniqueness, record in insertion order. Returns the resolved id
  /// for the caller (used as `PayloadHandler::allocate(..., id)` key
  /// and so on).
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

  /// Resolved ids in insertion order. Stable for the lifetime of this
  /// instance (`resolveAndTrack` only appends, never moves elements).
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
  /// on admission failure or duplicate rejection are harmless: ids only
  /// need to be unique within an accepted batch, which `resolveAndTrack`
  /// enforces per-call. `uint64_t` overflow is not a practical concern.
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
