#pragma once

#include <cstddef>
#include <functional>
#include <string>
#include <vector>

#include <llama.h>

#include "CacheLedger.hpp"

namespace qvac_lib_inference_addon_llama::cache {

// The longest of `checkpoints` (may be null) that is a prefix of `prompt` no
// longer than `limit` entries; null when none is.
inline const Checkpoint* longestCheckpointWithin(
    const Checkpoints* checkpoints, const Ledger& prompt, size_t limit) {
  const Checkpoint* best = nullptr;
  if (checkpoints == nullptr) {
    return best;
  }
  for (const Checkpoint& checkpoint : *checkpoints) {
    const size_t size = checkpoint.ledger.entries.size();
    if (size <= limit && commonPrefix(checkpoint.ledger, prompt) == size &&
        (best == nullptr || size > best->ledger.entries.size())) {
      best = &checkpoint;
    }
  }
  return best;
}

// The entries of `prompt` a full-state cached state can serve. Generation
// decodes the last prompt token again for its logits (`reconcilePrompt` backs
// reuse up to it), which full-state memory reaches only through a checkpoint,
// so a generating request is served only up to that token; media after it
// goes with it.
inline Ledger servablePrompt(const Ledger& prompt, bool isPrefillOnlyRequest) {
  Ledger servable = prompt;
  if (isPrefillOnlyRequest) {
    return servable;
  }
  size_t end = servable.entries.size();
  while (end > 0 && servable.entries[end - 1].kind != EntryKind::Token) {
    --end;
  }
  servable.truncate(end > 0 ? end - 1 : 0);
  return servable;
}

// Entries of `prompt` a state described by `state`, with its `checkpoints`,
// can serve without decoding them again. When the memory can be trimmed back
// to any position it is the whole shared prefix. Otherwise the whole state
// serves only when it is a prefix of the prompt, and a shorter shared prefix
// is served by the longest checkpoint within it.
inline size_t reusablePrefix(
    const Ledger& state, const Checkpoints* checkpoints, const Ledger& prompt,
    bool trimmable) {
  const size_t shared = commonPrefix(state, prompt);
  if (trimmable || shared == state.entries.size()) {
    return shared;
  }
  const Checkpoint* best = longestCheckpointWithin(checkpoints, prompt, shared);
  return best != nullptr ? best->ledger.entries.size() : 0;
}

// A conversation state another request can start from: a parked batch
// sequence, a RAM-tier entry or a cacheKey file. Valid only for the call that
// receives it; the conversation it belongs to is never changed.
struct DonorState {
  // Puts the state into `seqId`, whose memory is empty. False when it could
  // not; the caller then clears the sequence.
  std::function<bool(llama_context*, llama_seq_id)> copyInto;
  // Ledger words of the state, in the format `serialize` writes.
  const std::vector<llama_token>* ledgerWords = nullptr;
  // Checkpoints of the state, or null when it has none at hand.
  const Checkpoints* checkpoints = nullptr;
  // Where the state lives, for logs.
  std::string source;
};

// Adopts `donor` into the requesting sequence; true when it did.
using DonorAdopter = std::function<bool(const DonorState&)>;

// Hands `adopt` the state kept outside the requesting sequence with the
// longest `reusablePrefix` of `prompt`, when it exceeds `minimum` (what the
// sequence already serves). On full-state memory `prompt` is the request's
// `servablePrompt`; `promptCells` is the KV span of the whole prompt either
// way. Returns what `adopt` returned, or false when no state
// qualified. Set by the owner of those states: the single-prompt
// `CacheManager` and the `ContinuousBatchScheduler`.
using CacheSourceProvider = std::function<bool(
    const Ledger& prompt, llama_pos promptCells, bool trimmable, size_t minimum,
    const DonorAdopter& adopt)>;

} // namespace qvac_lib_inference_addon_llama::cache
