#pragma once

#include <cstdint>
#include <string>

#include "nmt.hpp"

constexpr int NMT_MAX_TENSOR_DIMS = 4;
constexpr int32_t NMT_MAX_TENSOR_NAME_LENGTH = 256;
constexpr int32_t NMT_MAX_VOCAB_TOKEN_LENGTH = 1024;
constexpr int32_t NMT_MAX_VOCAB_SIZE = 1000000;
constexpr int64_t NMT_MAX_SENTENCEPIECE_MODEL_BYTES = 64LL * 1024 * 1024;

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

bool nmtIsValidTensorType(int32_t ttype);

struct nmt_context* nmtInitWithParamsNoState(
    struct nmt_model_loader* loader, struct nmt_context_params params);

struct nmt_context* nmtInitFromFileWithParamsNoState(
    const char* pathModel, struct nmt_context_params params);
