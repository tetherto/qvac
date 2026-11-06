#pragma once

#include <vector>

#include <ggml.h>
#include <llama.h>

// The addon decodes through llama_batch, which fabric keeps in llama.h, while
// fabric's common library moved its helpers for it to common_batch.

inline void llamaBatchClear(llama_batch& batch) { batch.n_tokens = 0; }

inline void llamaBatchAdd(
    llama_batch& batch, llama_token id, llama_pos pos,
    const std::vector<llama_seq_id>& seqIds, bool logits) {
  GGML_ASSERT(batch.seq_id[batch.n_tokens] && "llama_batch size exceeded");

  batch.token[batch.n_tokens] = id;
  batch.pos[batch.n_tokens] = pos;
  batch.n_seq_id[batch.n_tokens] = static_cast<int32_t>(seqIds.size());
  for (size_t i = 0; i < seqIds.size(); ++i) {
    batch.seq_id[batch.n_tokens][i] = seqIds[i];
  }
  batch.logits[batch.n_tokens] = logits ? 1 : 0;

  batch.n_tokens++;
}
