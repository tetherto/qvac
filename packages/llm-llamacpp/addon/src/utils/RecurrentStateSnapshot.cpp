#include "RecurrentStateSnapshot.hpp"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

#include <common/common.h>
#include <llama.h>

namespace qvac_lib_inference_addon_llama {
namespace utils {

namespace {

uint64_t currentProcessId() noexcept {
#ifdef _WIN32
  return static_cast<uint64_t>(_getpid());
#else
  return static_cast<uint64_t>(::getpid());
#endif
}

// Produce a per-process unique temp file path for a snapshot. PID
// disambiguates across processes, `seqId` disambiguates concurrent
// per-slot snapshots in continuous batching, and the monotonic
// counter disambiguates back-to-back captures within the same slot.
std::string makeUniqueSnapshotPath(llama_seq_id seqId) {
  static std::atomic<uint64_t> counter{0};
  const auto id = counter.fetch_add(1, std::memory_order_relaxed);
  std::error_code ec;
  auto base = std::filesystem::temp_directory_path(ec);
  if (ec) {
    // Falling back to "." keeps the snapshot machinery functional on
    // systems where the temp dir lookup fails; the file is still
    // cleaned up on destruct / clear.
    base = ".";
  }
  const std::string filename = "qvac_llamacpp_seq_" +
                               std::to_string(currentProcessId()) + "_" +
                               std::to_string(static_cast<int>(seqId)) + "_" +
                               std::to_string(id) + ".bin";
  return (base / filename).string();
}

// Best-effort file removal. Used by the snapshot destructor and clear
// path, so it must not throw — a leaked temp file is recoverable, a
// thrown exception inside a destructor is not.
void removeFileQuiet(const std::string& path) noexcept {
  if (path.empty()) {
    return;
  }
  std::error_code ec;
  std::filesystem::remove(path, ec);
}

bool replayTokensThroughDecoderImpl(
    ::llama_context* lctx, llama_seq_id seqId,
    const std::vector<llama_token>& tokens, llama_pos startPos,
    bool outputLogitsForLast, int32_t chunkSize,
    const ReplayDecodeFunc& decodeFunc) {
  if (tokens.empty()) {
    return true;
  }
  if (lctx == nullptr || chunkSize <= 0 || !decodeFunc) {
    return false;
  }

  const int32_t total = static_cast<int32_t>(tokens.size());

  llama_batch batch = llama_batch_init(chunkSize, 0, 1);
  bool ok = true;
  for (int32_t offset = 0; offset < total && ok; offset += chunkSize) {
    const int32_t end = std::min(offset + chunkSize, total);
    common_batch_clear(batch);
    for (int32_t i = offset; i < end; ++i) {
      const bool isFinal = (i == total - 1);
      const bool requestLogits = outputLogitsForLast && isFinal;
      common_batch_add(
          batch,
          tokens[i],
          startPos + static_cast<llama_pos>(i),
          {seqId},
          requestLogits);
    }
    if (decodeFunc(lctx, batch) != 0) {
      ok = false;
    }
  }
  llama_batch_free(batch);
  return ok;
}

} // namespace

// ---- RecurrentStateSnapshot ----

RecurrentStateSnapshot::~RecurrentStateSnapshot() {
  removeFileQuiet(filePath_);
}

RecurrentStateSnapshot::RecurrentStateSnapshot(
    RecurrentStateSnapshot&& other) noexcept
    : nPast(other.nPast), filePath_(std::move(other.filePath_)),
      captured_(other.captured_) {
  other.filePath_.clear();
  other.nPast = 0;
  other.captured_ = false;
}

RecurrentStateSnapshot&
RecurrentStateSnapshot::operator=(RecurrentStateSnapshot&& other) noexcept {
  if (this != &other) {
    removeFileQuiet(filePath_);
    filePath_ = std::move(other.filePath_);
    nPast = other.nPast;
    captured_ = other.captured_;
    other.filePath_.clear();
    other.nPast = 0;
    other.captured_ = false;
  }
  return *this;
}

void RecurrentStateSnapshot::clear() noexcept {
  removeFileQuiet(filePath_);
  filePath_.clear();
  nPast = 0;
  captured_ = false;
}

void RecurrentStateSnapshot::seedForTesting(
    std::string filePath, llama_pos nPastAt) noexcept {
  removeFileQuiet(filePath_);
  filePath_ = std::move(filePath);
  nPast = nPastAt;
  captured_ = true;
}

void RecurrentStateSnapshot::seedEmptyForTesting(llama_pos nPastAt) noexcept {
  removeFileQuiet(filePath_);
  filePath_.clear();
  nPast = nPastAt;
  captured_ = true;
}

void RecurrentStateSnapshot::adoptFile(
    std::string filePath, llama_pos nPastAt) noexcept {
  removeFileQuiet(filePath_);
  filePath_ = std::move(filePath);
  nPast = nPastAt;
  captured_ = true;
}

void RecurrentStateSnapshot::adoptEmpty(llama_pos nPastAt) noexcept {
  removeFileQuiet(filePath_);
  filePath_.clear();
  nPast = nPastAt;
  captured_ = true;
}

// ---- Free functions ----

bool snapshotRecurrentState(
    ::llama_context* lctx, llama_seq_id seqId, llama_pos nPastAt,
    RecurrentStateSnapshot& out) {
  out.clear();
  if (lctx == nullptr) {
    return false;
  }

  // Empty sequence: there is no committed state worth persisting,
  // but we still need to mark the capture so the rollback machinery
  // can tell "we captured an empty state" apart from "we never
  // captured anything". Restore for this case clears the sequence
  // via `llama_memory_seq_rm`, matching the legacy in-memory variant
  // (where `set_data_ext` on the empty-state bytes effectively reset
  // the recurrent / hybrid memory to its pre-decode shape).
  if (nPastAt <= 0) {
    out.adoptEmpty(nPastAt);
    return true;
  }

  // Write the full state (KV + recurrent) to a temp file via
  // `llama_state_seq_save_file`. Internally this calls
  // `state_seq_write_data(io, seq_id, /*flags=*/0)`, llama.cpp's
  // full-state sequence path. We do not save any prompt tokens
  // alongside the state; those are recovered from `nPast` /
  // `postReasoningTokens_` at restore time.
  std::string path = makeUniqueSnapshotPath(seqId);
  const size_t savedBytes = llama_state_seq_save_file(
      lctx,
      path.c_str(),
      seqId,
      /*tokens=*/nullptr,
      /*n_token_count=*/0);
  if (savedBytes == 0) {
    removeFileQuiet(path);
    return false;
  }

  out.adoptFile(std::move(path), nPastAt);
  return true;
}

bool restoreRecurrentState(
    ::llama_context* lctx, llama_seq_id seqId,
    const RecurrentStateSnapshot& snapshot) {
  if (lctx == nullptr) {
    return false;
  }
  if (snapshot.empty()) {
    // No capture recorded — nothing to do, but report success so
    // callers can chain restore + replay without special-casing the
    // "no snapshot taken" path.
    return true;
  }
  if (!snapshot.hasFile()) {
    // Captured-but-empty: rewind the sequence to a clean state. We
    // can't use a file load here (there is no payload), but the
    // sequence-clear primitive is the correct semantic equivalent —
    // both attention KV cells and the recurrent / hybrid hidden
    // state for `seqId` are dropped, so the next decode starts from
    // pos 0 with a virgin memory. Propagate the primitive's result:
    // reporting success after a refused clear would let callers save
    // metadata for an empty sequence while live memory still contains
    // stale recurrent state.
    auto* mem = llama_get_memory(lctx);
    if (mem == nullptr) {
      return false;
    }
    return llama_memory_seq_rm(mem, seqId, -1, -1);
  }
  size_t nTokenCount = 0;
  const size_t loadedBytes = llama_state_seq_load_file(
      lctx,
      snapshot.filePath().c_str(),
      seqId,
      /*tokens_out=*/nullptr,
      /*n_token_capacity=*/0,
      &nTokenCount);
  return loadedBytes != 0;
}

bool replayTokensThroughDecoder(
    ::llama_context* lctx, llama_seq_id seqId,
    const std::vector<llama_token>& tokens, llama_pos startPos,
    bool outputLogitsForLast) {
  if (tokens.empty()) {
    return true;
  }
  if (lctx == nullptr) {
    return false;
  }

  // Chunk the replay so it fits within the context's micro-batch
  // capacity. `llama_n_batch` returns the logical batch size; we use
  // it as an upper bound on `common_batch_add` calls per `llama_decode`.
  const auto nBatchU = llama_n_batch(lctx);
  if (nBatchU == 0) {
    return false;
  }
  const int32_t chunkSize = static_cast<int32_t>(nBatchU);
  return replayTokensThroughDecoderImpl(
      lctx,
      seqId,
      tokens,
      startPos,
      outputLogitsForLast,
      chunkSize,
      [](auto* ctx, llama_batch batch) { return llama_decode(ctx, batch); });
}

bool replayTokensThroughDecoderForTesting(
    ::llama_context* lctx, llama_seq_id seqId,
    const std::vector<llama_token>& tokens, llama_pos startPos,
    bool outputLogitsForLast, int32_t chunkSize, ReplayDecodeFunc decodeFunc) {
  return replayTokensThroughDecoderImpl(
      lctx,
      seqId,
      tokens,
      startPos,
      outputLogitsForLast,
      chunkSize,
      decodeFunc);
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
