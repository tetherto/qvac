#pragma once

#include <cstdint>

#include "nmt.hpp"

constexpr int NMT_MAX_TENSOR_DIMS = 4;
constexpr int32_t NMT_MAX_TENSOR_NAME_LENGTH = 256;

bool nmt_read_tensor_dims(
    struct nmt_model_loader* loader,
    int32_t n_dims,
    int32_t (&ne)[NMT_MAX_TENSOR_DIMS],
    int32_t& nelements);

struct nmt_context* nmtInitWithParamsNoState(
    struct nmt_model_loader* loader, struct nmt_context_params params);

struct nmt_context* nmtInitFromFileWithParamsNoState(
    const char* pathModel, struct nmt_context_params params);
