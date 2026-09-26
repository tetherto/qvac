#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

// Parse-only surface for the GGML weight-header readers. Isolated from nmt.hpp
// so a FuzzTest TU can compile these without sentencepiece / Bergamot / the
// onnxruntime-pinned Abseil those pull in. See
// docs/architecture/ADDON-FUZZING.md.

constexpr int NMT_MAX_TENSOR_DIMS = 4;
constexpr int32_t NMT_MAX_TENSOR_NAME_LENGTH = 256;
constexpr int32_t NMT_MAX_VOCAB_TOKEN_LENGTH = 1024;
constexpr int32_t NMT_MAX_VOCAB_SIZE = 1000000;
constexpr int64_t NMT_MAX_SENTENCEPIECE_MODEL_BYTES = 64LL * 1024 * 1024;

// C-style loader vtable shared with nmt.hpp (`nmt_context`,
// `nmt_context_params`). Keep snake_case; do not modernize in isolation.
// NOLINTBEGIN(readability-identifier-naming)
typedef struct nmt_model_loader {
  void* context;

  size_t (*read)(void* ctx, void* output, size_t read_size);
  bool (*eof)(void* ctx);
  void (*close)(void* ctx);
} nmt_model_loader;

bool nmtReadTensorDims(
    struct nmt_model_loader* loader, int32_t nDims,
    int32_t (&ne)[NMT_MAX_TENSOR_DIMS], int32_t& nelements);

bool nmtReadBoundedString(
    struct nmt_model_loader* loader, int64_t length, int64_t maxLength,
    std::string& out);

bool nmtReadTensorName(
    struct nmt_model_loader* loader, int32_t length, std::string& name);

bool nmtReadCount(
    struct nmt_model_loader* loader, int32_t maxCount, int32_t& count);
// NOLINTEND(readability-identifier-naming)

bool nmtIsValidTensorType(int32_t ttype);
