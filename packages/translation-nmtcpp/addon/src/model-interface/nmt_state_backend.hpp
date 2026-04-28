#pragma once

#include <cstdint>

#include "ggml-backend.h"
#include "ggml.h"
#include "nmt.hpp"

struct nmt_batch nmt_batch_init(int32_t n_tokens, int32_t n_seq_max);

void nmt_batch_prep_legacy(
    nmt_batch& batch, const nmt_token* tokens, int n_tokens, int n_past,
    int seq_id);

uint32_t nmt_kv_cache_get_padding(const struct nmt_context& ctx);

int32_t nmt_kv_cache_cell_max(const struct nmt_kv_cache& cache);

bool nmt_kv_cache_find_slot(
    struct nmt_kv_cache& cache, const struct nmt_batch& batch);

void nmt_kv_cache_clear(struct nmt_kv_cache& cache);

bool nmt_kv_cache_init(
    struct nmt_kv_cache& cache, ggml_backend_t backend, ggml_type wtype,
    int64_t d_model, int64_t n_decoder_layers, int n_ctx);

void nmt_kv_cache_free(struct nmt_kv_cache& cache);

void nmt_free_state(struct nmt_state* state);

void nmt_reset_runtime_stats(struct nmt_context* ctx);

int nmt_get_runtime_stats(
    struct nmt_context* ctx, double* encode_time, double* decode_time,
    int* total_tokens);

void nmt_reset_state(struct nmt_context* ctx);

struct nmt_state* nmt_init_state(nmt_context* ctx);

void nmt_batch_free(struct nmt_batch batch);