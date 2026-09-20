#pragma once

#include <llama.h>

#include "SequenceStateSnapshot.hpp"

namespace qvac_lib_inference_addon_llama::utils {

// Process-local full-state snapshot used to make cancellation transactional
// on models whose memory cannot remove an arbitrary decoded tail (see
// `needsFullStateSnapshot` in ModelMemoryPolicy.hpp). This state is unrelated
// to reasoning retention: it captures the sequence at request entry and
// restores that exact state when the request is cancelled or fails.
class RequestRollbackState {
public:
  bool capture(::llama_context* ctx, llama_seq_id seqId, llama_pos nPast);
  bool restore(::llama_context* ctx, llama_seq_id seqId);

  [[nodiscard]] bool hasSnapshot() const noexcept { return !snapshot_.empty(); }
  [[nodiscard]] llama_pos nPast() const noexcept { return snapshot_.nPast; }

  void clear() noexcept { snapshot_.clear(); }

private:
  SequenceStateSnapshot snapshot_;
};

} // namespace qvac_lib_inference_addon_llama::utils
