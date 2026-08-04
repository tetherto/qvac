// Shared helpers for the GR00T milestone parity tests (M4.2/M4.4/M4.6), which
// read the embodiment.* weights straight from the GGUF rather than through
// grootLoadModel's load-time selection. A multi-embodiment GGUF stores each
// embodiment.* weight as rank-3 [out, in, n_stored] (bias rank-2 [out,
// n_stored]); a v1 single-embodiment GGUF stores them already-sliced as rank-2
// / rank-1. These helpers hand those tests a rank-2 / rank-1 view of the GGUF's
// default embodiment row, so the same graph + oracle (libero_sim) work on
// either fixture. grootLoadModel does the equivalent copy-slice at load; the
// full-model tests (infer-parity, load) exercise that path already.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>

#include <ggml.h>
#include <gguf.h>

namespace groot_embodiment_test_util {

// Row index of the GGUF's default embodiment within stored_cat_ids, or 0 for a
// single-embodiment GGUF (no table -> the tensors are already the one row).
// This mirrors grootResolveEmbodiment's cat_id -> stored-row step (default tag
// -> baked cat_id -> index in stored_cat_ids) for the '' selection; keep the
// two in sync if that mapping rule ever changes. Kept as a standalone raw-GGUF
// lookup (not a grootResolveEmbodiment call) so the parity tests can find the
// default row without the resolver's full table + num_cameras validation.
// Aborts if the table is present but has no row for the default cat_id: row 0
// would then be a silently wrong embodiment, and the milestone tests would
// compare a different embodiment's weights against the oracle and fail as a
// numeric mismatch instead of naming the real fault.
inline int defaultEmbodimentRow(struct gguf_context* gguf) {
  const int64_t storedKey =
      gguf_find_key(gguf, "groot.embodiment.stored_cat_ids");
  if (storedKey < 0 || gguf_get_arr_type(gguf, storedKey) != GGUF_TYPE_INT32) {
    return 0;
  }
  const int64_t catKey = gguf_find_key(gguf, "groot.embodiment_cat_id");
  if (catKey < 0) {
    return 0;
  }
  const uint32_t defaultCatId = gguf_get_val_u32(gguf, catKey);
  const size_t n = gguf_get_arr_n(gguf, storedKey);
  const auto* stored =
      static_cast<const int32_t*>(gguf_get_arr_data(gguf, storedKey));
  for (size_t i = 0; i < n; ++i) {
    if (static_cast<uint32_t>(stored[i]) == defaultCatId) {
      return static_cast<int>(i);
    }
  }
  GGML_ABORT(
      "defaultEmbodimentRow: groot.embodiment.stored_cat_ids has no row for "
      "default cat_id %u",
      defaultCatId);
}

// Byte-copy `row` of a rank-(baseNdims+1) multi-embodiment tensor into a fresh
// CONTIGUOUS rank-baseNdims tensor; pass through unchanged when the tensor is
// already one row (v1 GGUF). Mirrors production grootSliceEmbodiment exactly.
//
// An earlier version returned a ggml_view instead. That passed on macOS but
// aborted on every CI runner (GGML_ASSERT(ggml_can_mul_mat) in grootLinearXW):
// the view -> transpose -> cont -> mul_mat path leaks the outer stored-row
// dimension into mul_mat under the CI ggml build. The load path never hit this
// because grootSliceEmbodiment byte-copies, so GrootLoad passed while M4.2/4.4/
// M4.6 crashed. Copying here matches that proven path. Rows are the outermost
// axis so each row's `[out, in]` / `[out]` block is contiguous. `ctx` must be
// data-backed (no_alloc = false).
inline struct ggml_tensor* embodimentRow(
    struct ggml_context* ctx, struct ggml_tensor* t, int row, int baseNdims) {
  if (t == nullptr || t->ne[baseNdims] <= 1) {
    return t; // v1 single-embodiment: already the one row
  }
  struct ggml_tensor* dst =
      baseNdims == 2 ? ggml_new_tensor_2d(ctx, t->type, t->ne[0], t->ne[1])
                     : ggml_new_tensor_1d(ctx, t->type, t->ne[0]);
  // Callers pass their own compute context as the slice arena (M4.2 reuses its
  // 128 MiB pool), and ggml_new_tensor returns NULL on an exhausted arena once
  // GGML_ASSERT is compiled out. Report that rather than memcpy through NULL.
  if (dst == nullptr) {
    std::fprintf(
        stderr,
        "[embodimentRow] slice alloc failed for %s — arena exhausted\n",
        ggml_get_name(t));
    return nullptr;
  }
  const size_t block = ggml_nbytes(dst);
  std::memcpy(
      dst->data,
      static_cast<const char*>(t->data) + static_cast<size_t>(row) * block,
      block);
  return dst;
}

} // namespace groot_embodiment_test_util
