#pragma once

#include <cstdint>
#include <string>

#include "CacheLedger.hpp"

namespace qvac_lib_inference_addon_llama::cache {

// A cacheKey file can carry the conversation's newest checkpoint after its
// sequence state, so a model loaded in a new process restores the
// end-of-history checkpoint instead of reprocessing the whole conversation on
// a hybrid or recurrent model. llama.cpp's `llama_state_seq_load_file` stops
// reading at the end of the sequence state and returns that offset, so files
// with the section load unchanged in older addon versions, which ignore it.
//
// Layout, host byte order like the rest of the file:
//   u32 magic "QCKP" · u32 version · u32 count (1 when written by this
//   version; readers accept any count up to the checkpoint limit)
//   per checkpoint, oldest first:
//     i32 nPast · i32 cacheTokens
//     u32 word count · the checkpoint's ledger (`serialize`)
//     u64 payload size · the partial state (`llama_state_seq_get_data_ext`)
//   u64 checksum over everything above except the payloads
// The section ends the file; a file without checkpoints has none.
inline constexpr uint32_t CHECKPOINT_SECTION_MAGIC = 0x504b4351; // "QCKP"
inline constexpr uint32_t CHECKPOINT_SECTION_VERSION = 1;

/// Appends the newest of `checkpoints` (the last partial checkpoint with a
/// payload) to the cacheKey file at `path`, which already holds the header,
/// the ledger and the sequence state (a `.tmp` file before its promotion). It
/// is the one an ordinary next turn and a regenerate restore. With none the
/// file is left untouched. On a write failure the file is cut back to its
/// previous size, so the state is still saved, and false is returned.
bool appendCheckpointSection(
    const std::string& path, const Checkpoints& checkpoints) noexcept;

/// Reads the checkpoints kept in the cacheKey file at `path`, whose sequence
/// state ends at `offset` (the value `llama_state_seq_load_file` returned).
/// Each is stored per `policy` (memory or disk) and kept only when its ledger
/// is a prefix of `resident`, the ledger loaded from the same file; the list
/// is then trimmed to `policy`'s count and byte limits, oldest first. A
/// missing section returns none; a malformed or unknown one is logged and
/// returns none, leaving the loaded state as it is.
[[nodiscard]] Checkpoints readCheckpointSection(
    const std::string& path, uint64_t offset, const Ledger& resident,
    const CheckpointPolicy& policy) noexcept;

} // namespace qvac_lib_inference_addon_llama::cache
