#pragma once

#include <cstdint>
#include <vector>

#include "ggml-backend.h"
#include "ggml.h"
#include "nmt.hpp"

void applyRepetitionPenalty(
    std::vector<float>& logits, const std::vector<int32_t>& generatedTokens,
    float penalty);

struct ggml_cgraph* nmtBuildGraphDecoder(
    nmt_context& ctx, nmt_state& state, const nmt_batch& batch, bool worstCase);

bool nmtDecodeInternal(nmt_context& ctx, nmt_batch& batch, nmt_state& state);

void indictransComputeSinusoidalPositionalEmbeddingsToBuffer(
    float* data, int dModel, int maxLen);

void applyTopKFilter(
    std::vector<float>& logits,
    std::vector<nmt_pair<float, nmt_vocab::id>>& logitsId, int topK);

void applyNoRepeatNgramFilter(
    std::vector<float>& logits, const std::vector<nmt_vocab::id>& tokens,
    int noRepeatNgramSize);

void nmtComputeLogprobs(
    const std::vector<float>& logits, int nLogits,
    std::vector<float>& logprobs);
