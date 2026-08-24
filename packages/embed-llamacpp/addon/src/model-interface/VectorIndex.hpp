#pragma once
//
// RAII C++ wrapper around fabric's `ggml_vec_index_t*` C handle. Provides
// typed methods + status-aware accessors. Lifecycle isolated from
// LlamaLazyInitializeBackend / BertModel by construction: this header
// only depends on the ggml-base vector-index C API.

#include <cstdint>
#include <string>

#include <ggml-vector-index.h>

namespace qvac_lib_infer_llamacpp_embed {

class VectorIndexFilter {
public:
  explicit VectorIndexFilter(ggml_vec_index_filter_t* handle) noexcept;
  ~VectorIndexFilter();

  VectorIndexFilter(const VectorIndexFilter&) = delete;
  VectorIndexFilter& operator=(const VectorIndexFilter&) = delete;
  VectorIndexFilter(VectorIndexFilter&& other) noexcept;
  VectorIndexFilter& operator=(VectorIndexFilter&& other) noexcept;

  [[nodiscard]] bool valid() const noexcept { return handle_ != nullptr; }
  [[nodiscard]] ggml_vec_index_filter_t* raw() const noexcept {
    return handle_;
  }

private:
  ggml_vec_index_filter_t* handle_;
};

class VectorIndex {
public:
  // Construct a fresh empty index. Throws std::invalid_argument on bad
  // dims / storage mode.
  VectorIndex(int dim, int bitWidth, const std::string& storage = {});

  // Adopt an already-opened native handle (used by static load).
  explicit VectorIndex(ggml_vec_index_t* handle) noexcept;

  ~VectorIndex();

  VectorIndex(const VectorIndex&) = delete;
  VectorIndex& operator=(const VectorIndex&) = delete;
  VectorIndex(VectorIndex&& other) noexcept;
  VectorIndex& operator=(VectorIndex&& other) noexcept;

  // Returns 0 on success, ggml_vec_index_error on failure (e.g. duplicate).
  int add(const float* vectors, int n, const uint64_t* ids) noexcept;

  int addLogged(
      const float* vectors, int n, const uint64_t* ids,
      const std::string& deltaPath) noexcept;

  // Returns GGML_VEC_INDEX_OK when removed, E_NOT_FOUND when absent.
  int remove(uint64_t id) noexcept;

  int removeLogged(uint64_t id, const std::string& deltaPath) noexcept;

  // Physically removes deleted slots from in-memory storage.
  int compact() noexcept;

  [[nodiscard]] bool contains(uint64_t id) const noexcept;

  void prepare() noexcept;

  int buildIvf(int nLists, int nIter) noexcept;

  // Top-k search. Caller owns out arrays of size nQ * k.
  int search(
      const float* queries, int nQ, int k, float* outScores,
      uint64_t* outIds) const noexcept;

  // Top-k search restricted to the caller-supplied allowlist.
  int searchFiltered(
      const float* queries, int nQ, int k, const uint64_t* allowedIds,
      int nAllowed, float* outScores, uint64_t* outIds) const noexcept;

  // Creates a reusable filter for repeated allowlist searches.
  VectorIndexFilter
  createFilter(const uint64_t* allowedIds, int nAllowed) const noexcept;

  int searchPreparedFiltered(
      const VectorIndexFilter& filter, const float* queries, int nQ, int k,
      float* outScores, uint64_t* outIds) const noexcept;

  int searchIvf(
      const float* queries, int nQ, int k, int nProbe, float* outScores,
      uint64_t* outIds) const noexcept;

  // Persists to disk. Returns 0 on success.
  int write(const std::string& path) noexcept;

  int compactDelta(
      const std::string& snapshotPath, const std::string& deltaPath) noexcept;

  // Reads from disk. On failure returns a wrapper whose `valid()` is false and
  // writes the precise ggml_vec_index_error to status.
  static VectorIndex load(const std::string& path, int* status) noexcept;

  static VectorIndex loadWithDelta(
      const std::string& snapshotPath, const std::string& deltaPath,
      int* status) noexcept;

  // Reads from disk with mmap-backed vector storage. Mutations fail.
  static VectorIndex loadMmap(const std::string& path, int* status) noexcept;

  // Stats.
  [[nodiscard]] int len() const noexcept;
  [[nodiscard]] int dim() const noexcept;
  [[nodiscard]] int bitWidth() const noexcept;

  // True if this instance owns a native handle (i.e. wasn't moved-from /
  // wasn't a failed load).
  [[nodiscard]] bool valid() const noexcept { return handle_ != nullptr; }

  // Raw handle accessor for the JS binding's finalizer. Caller must not
  // free; ownership remains with this object.
  [[nodiscard]] ggml_vec_index_t* raw() const noexcept { return handle_; }

private:
  ggml_vec_index_t* handle_;
};

} // namespace qvac_lib_infer_llamacpp_embed
