#pragma once

#include <cstdint>
#include <string>

#include "nmt.hpp"

constexpr int NMT_MAX_TENSOR_DIMS = 4;
constexpr int32_t NMT_MAX_TENSOR_NAME_LENGTH = 256;

bool nmtReadTensorDims(
    struct nmt_model_loader* loader, int32_t nDims,
    int32_t (&ne)[NMT_MAX_TENSOR_DIMS], int32_t& nelements);

bool nmtReadTensorName(
    struct nmt_model_loader* loader, int32_t length, std::string& name);

struct nmt_context* nmtInitWithParamsNoState(
    struct nmt_model_loader* loader, struct nmt_context_params params);

struct nmt_context* nmtInitFromFileWithParamsNoState(
    const char* pathModel, struct nmt_context_params params);
