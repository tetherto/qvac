#pragma once

#include <cstdint>
#include <vector>

#include "ggml-backend.h"
#include "ggml.h"
#include "nmt.hpp"

void apply_repetition_penalty(
    std::vector<float>& logits, const std::vector<int32_t>& generated_tokens,
    float penalty);

struct ggml_cgraph* nmt_build_graph_decoder(
    nmt_context& ctx, nmt_state& state, const nmt_batch& batch,
    bool worst_case);

bool nmt_decode_internal(nmt_context& ctx, nmt_batch& batch, nmt_state& state);

void indictrans_compute_sinusoidal_positional_embeddings_to_buffer(
    float* data, int d_model, int max_len);

void apply_top_k_filter(
    std::vector<float>& logits,
    std::vector<nmt_pair<float, nmt_vocab::id>>& logits_id, const int top_k);

void apply_no_repeat_ngram_filter(
    std::vector<float>& logits, const std::vector<nmt_vocab::id>& tokens,
    int no_repeat_ngram_size);

void nmt_compute_logprobs(
    const std::vector<float>& logits, const int n_logits,
    std::vector<float>& logprobs);
