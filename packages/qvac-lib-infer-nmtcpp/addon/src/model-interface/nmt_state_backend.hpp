#pragma once

#include <cstdint>

#include "ggml-backend.h"
#include "ggml.h"
#include "nmt.hpp"

struct nmt_batch nmtBatchInit(int32_t nTokens, int32_t nSeqMax);

void nmtBatchPrepLegacy(
    nmt_batch& batch, const nmt_token* tokens, int nTokens, int nPast,
    int seqId);

uint32_t nmtKvCacheGetPadding(const struct nmt_context& ctx);

int32_t nmtKvCacheCellMax(const struct nmt_kv_cache& cache);

bool nmtKvCacheFindSlot(
    struct nmt_kv_cache& cache, const struct nmt_batch& batch);

void nmtKvCacheClear(struct nmt_kv_cache& cache);

bool nmtKvCacheInit(
    struct nmt_kv_cache& cache, ggml_backend_t backend, ggml_type wtype,
    int64_t dModel, int64_t nDecoderLayers, int nCtx);

void nmtKvCacheFree(struct nmt_kv_cache& cache);

void nmtFreeState(struct nmt_state* state);

struct nmt_state* nmtInitState(nmt_context* ctx);

void nmtBatchFree(struct nmt_batch batch);
