#pragma once

#include <cstdint>
#include <vector>

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

// Removes seqId from every cell; a cell that no sequence uses becomes free.
void nmtKvCacheSeqRm(struct nmt_kv_cache& cache, nmt_seq_id seqId);

// Adds seqDst to every cell that belongs to seqSrc. No K/V data is copied:
// both sequences now share those cells.
void nmtKvCacheSeqCp(
    struct nmt_kv_cache& cache, nmt_seq_id seqSrc, nmt_seq_id seqDst);

// Moves the cells of parentSeqIds[i] to sequence i, for every i. A parent may
// be listed several times (it then has several children). Any sequence in
// [0, nSeqMax) that is not a child afterwards loses its cells.
void nmtKvCacheReassignSeqs(
    struct nmt_kv_cache& cache, const std::vector<nmt_seq_id>& parentSeqIds,
    int nSeqMax);

// Fills mask with batch.n_tokens rows of nKv values for the decoder
// self-attention: 0 where token i may attend cell j (the cell belongs to the
// token's sequence and is not after it), -INFINITY elsewhere.
void nmtKvCacheBuildMask(
    const struct nmt_kv_cache& cache, const struct nmt_batch& batch, int nKv,
    std::vector<float>& mask);

void nmtFreeState(struct nmt_state* state);

struct nmt_state* nmtInitState(nmt_context* ctx);

void nmtBatchFree(struct nmt_batch batch);
