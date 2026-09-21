#include "model-interface/groot.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <gguf.h>

#include "model-interface/gguf_helpers.hpp"
#include "utils/BackendSelection.hpp"
#include "utils/LoggingMacros.hpp"

// Short alias so the QLOG_IF priorities read the same here as in
// pi05.cpp / smolvla.cpp / BackendSelection.cpp.
using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

namespace qvac_lib_infer_vla_ggml {

// Derive Qwen3-VL 3-axis M-RoPE position ids for the fixed GR00T fixture,
// C++-side (option b). Reproduces HF's `get_rope_index` for the interleaved
// text / image layout: a text token advances all 3 axes by one from the
// running maximum; an image (a `gh`×`gw` merged-patch grid, detected as a
// contiguous run of `imageTokenId` in `tokens`) shares one temporal id `st`
// across the whole image while height/width axes fan out as `st+row`/`st+col`,
// after which the next id resumes at `st + max(gh, gw)`. Output layout matches
// the text-decoder graph's `positions` input: axis-major [axis0|axis1|axis2|
// axis3] each of length `nTokens`, axis3 (the unused width-0 rope section) left
// zero. Verified byte-for-byte against the oracle
// text_model_input.position_ids.
void grootDeriveMRopePositions(
    const int32_t* tokens, int nTokens, int imageTokenId, int gh, int gw,
    int32_t* out) {
  int nxt = 0; // next position value = (running max) + 1
  int t = 0;
  while (t < nTokens) {
    if (tokens[t] == imageTokenId) {
      // Defensive: never let a partial image run at the sequence tail index
      // past `out` (sized nTokens*4). infer() already rejects any layout that
      // isn't nImages full mergedPerImg runs, so this is belt-and-suspenders
      // for any future caller that skips that validation.
      if (t + gh * gw > nTokens) {
        break;
      }
      const int st = nxt;
      for (int r = 0; r < gh; ++r) {
        for (int col = 0; col < gw; ++col) {
          const int idx = t + r * gw + col;
          out[0 * nTokens + idx] = st;
          out[1 * nTokens + idx] = st + r;
          out[2 * nTokens + idx] = st + col;
          out[3 * nTokens + idx] = 0;
        }
      }
      nxt = st + std::max(gh, gw);
      t += gh * gw;
    } else {
      out[0 * nTokens + t] = nxt;
      out[1 * nTokens + t] = nxt;
      out[2 * nTokens + t] = nxt;
      out[3 * nTokens + t] = 0;
      ++nxt;
      ++t;
    }
  }
}

// ── Small shared graph helpers (mirrors pi05.cpp's static defs) ──────────
namespace {

// Promote non-F32 weights to F32 on-graph so they share a dtype with the
// F32 activations they combine with (biases/norm weights are stored F16).
static struct ggml_tensor*
grootToF32(struct ggml_context* ctx, struct ggml_tensor* x) {
  if (x != nullptr && x->type != GGML_TYPE_F32) {
    return ggml_cast(ctx, x, GGML_TYPE_F32);
  }
  return x;
}

// LayerNorm with weight + bias (diffusers/torch nn.LayerNorm, eps default
// 1e-5).
static struct ggml_tensor* grootLayerNorm(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias, float eps) {
  x = ggml_norm(ctx, x, eps);
  if (weight != nullptr) {
    x = ggml_mul(ctx, x, grootToF32(ctx, weight));
  }
  if (bias != nullptr) {
    x = ggml_add(ctx, x, grootToF32(ctx, bias));
  }
  return x;
}

// Linear: y = x @ W^T (+ b). ggml_mul_mat(W, x) treats W as ne=[in, out]
// (nn.Linear's PyTorch (out, in) row-major → ggml [in, out]) and x as
// (..., in), producing (out, ...).
static struct ggml_tensor* grootLinear(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias) {
  struct ggml_tensor* out = ggml_mul_mat(ctx, weight, x);
  if (bias != nullptr) {
    out = ggml_add(ctx, out, grootToF32(ctx, bias));
  }
  return out;
}

// CategorySpecificLinear semantics: y = x @ W + b, with W stored [in, out]
// (its forward is `torch.bmm(x, W)`, NOT nn.Linear's `x @ W^T`). Sliced to one
// embodiment, the GGUF tensor is that [in, out] matrix → ggml ne=[out, in].
// ggml_mul_mat wants the weight as ne=[in, out], so transpose it here.
// (convert_groot_dit_to_gguf.py stores it untransposed and its "no transpose
// needed" comment is incorrect — this is the compensating transpose, verified
// against CategorySpecificLinear.forward in embodiment_conditioned_mlp.py.)
static struct ggml_tensor* grootLinearXW(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias) {
  struct ggml_tensor* wt = ggml_cont(ctx, ggml_transpose(ctx, weight));
  struct ggml_tensor* out = ggml_mul_mat(ctx, wt, x);
  if (bias != nullptr) {
    out = ggml_add(ctx, out, grootToF32(ctx, bias));
  }
  return out;
}

} // namespace

// ── Internal model state ────────────────────────────────────────────────
// Two weight-residency paths, selected at load (see grootLoadModel):
//   * CPU: no_alloc=false — gguf_init_from_file mmaps the file, tensor `data`
//     points straight at the OS page cache (zero extra heap, the low-footprint
//     path mobile relies on). Compute runs on backend_cpu via ggml_gallocr.
//   * GPU: no_alloc=true + grootLoadWeightsAllocCopy streams the weights into a
//     device backend buffer; infer() runs each phase through a
//     ggml_backend_sched over {gpu, cpu}. Mirrors smolvla/pi05.

// Per-phase allocator/scheduler, cached in GrootModelInternal and reused across
// infer() calls (see grootSchedAlloc). Defined here so GrootModelInternal can
// hold it by value.
struct GrootSched {
  ggml_gallocr_t galloc = nullptr;
  ggml_backend_sched_t sched = nullptr;
  // Capacity (graph_size) the sched/galloc was built for. On calls after the
  // first, grootSchedAlloc resets the cached sched and re-allocs the
  // freshly-built graph instead of paying ggml_backend_sched_new (~14ms) again;
  // rebuilt only when a later call's graph exceeds this capacity (longer
  // prompt).
  size_t graph_cap = 0;
};

struct GrootModelInternal {
  // hparams (also mirrored into GrootModel::hparams_)
  int text_num_layers = 16;
  int text_hidden_size = 2048;
  int text_num_heads = 16;
  int text_num_kv_heads = 8;
  int text_head_dim = 128;
  int text_ffn_length = 6144;
  int text_vocab_size = 151936;
  float text_rope_freq_base = 5000000.0f;
  float text_rms_norm_eps = 1e-6f;
  int text_rope_sections[4] = {24, 20, 20, 0};
  int image_token_id = 151655; // Qwen3-VL image placeholder id

  int vision_depth = 24;
  int vision_hidden_size = 1024;
  int vision_num_heads = 16;
  int vision_patch_size = 16;
  int vision_spatial_merge_size = 2;
  int vision_temporal_patch_size = 2;
  int vision_num_position_embeddings = 2304;
  int vision_out_hidden_size = 2048;
  int vision_image_size = 256;
  std::vector<int> vision_deepstack_indexes; // [5, 11, 17]

  int hidden_size = 1024;         // action_head.hidden_size
  int input_embedding_dim = 1536; // DiT inner_dim
  int backbone_embedding_dim =
      2048; // vlfusion inner_dim / DiT cross_attention_dim
  int max_state_dim = 132;
  int max_action_dim = 132;
  int num_cameras = 2; // LIBERO: image + wrist_image
  int action_horizon = 40;
  int num_inference_timesteps = 4;
  int timestep_proj_channels = 256;

  int dit_num_layers = 32;
  int dit_num_heads = 32;
  int dit_head_dim = 48;
  int dit_ffn_inner = 6144;
  int dit_output_dim = 1024;
  int dit_num_timestep_buckets = 1000;
  int dit_attend_text_every_n_blocks = 2;

  int vlfusion_num_layers = 4;
  int vlfusion_num_heads = 32;
  int vlfusion_head_dim = 64;
  int vlfusion_ffn_inner = 8192;

  std::string embodiment_tag;
  int embodiment_cat_id = -1;

  // Multi-embodiment table (empty on v1 single-embodiment GGUFs). `tags`/
  // `cat_ids` are the full tag -> cat_id map; `stored_cat_ids` lists which
  // cat_ids are physically stored, in weight-tensor row order, with parallel
  // `stored_num_cameras`. The load-time selection is resolved into
  // `selected_*` below (see grootResolveEmbodiment / grootSliceEmbodiment).
  std::vector<std::string> embodiment_tags;
  std::vector<int> embodiment_cat_ids;
  std::vector<int> embodiment_stored_cat_ids;
  std::vector<int> embodiment_stored_num_cameras;
  std::string selected_embodiment_tag;
  int selected_cat_id = -1;
  int selected_row = -1; // row of selected_cat_id in embodiment_stored_cat_ids
  // The file's top-level groot.num_cameras. `num_cameras` above holds the
  // SELECTED embodiment's count and is rewritten by setEmbodiment, so the
  // resolver's fallback has to read this untouched copy instead.
  int gguf_default_num_cameras = 0;
  // Absolute path of the GGUF these weights came from. Kept for
  // grootFillEmbodimentRow: after load the file is the only remaining source of
  // the unselected embodiment rows (the GPU path's host staging is released and
  // its rank-3 tensors' data pointers nulled), so a later setEmbodiment
  // re-reads the wanted row from disk.
  std::string gguf_path;

  // weight pointers — all owned by `ctx_w` below.
  GrootVisionWeights vision{};
  GrootTextWeights text{};
  GrootVlfusionWeights vlfusion{};
  GrootDitWeights dit{};
  GrootEmbodimentWeights embodiment{};

  // backends + memory
  struct gguf_context* gguf = nullptr;
  struct ggml_context* ctx_w = nullptr;
  ggml_backend_t backend = nullptr;
  ggml_backend_t backend_cpu = nullptr;
  bool has_gpu = false;
  std::string backend_name = "none";

  // Backend buffer(s) owning the weight tensor storage on the GPU alloc+copy
  // path (has_gpu). Empty on the CPU mmap path (weights point into the page
  // cache). Freed before ctx_w in the destructor so the tensors they back stay
  // valid through the free callback.
  std::vector<ggml_backend_buffer_t> bufs_w;

  // Host-resident copies of the three vision weights that infer() reads on the
  // CPU at build time — the patch-embed conv halves (reshaped into the linear
  // weight) and the position-embed table (exact align-corners bilinear). On the
  // GPU path ctx_w's copies live in device memory and can't be dereferenced
  // host-side, so these are populated from the GGUF file instead. Unused (left
  // null) on the CPU path, where the ctx_w tensors are already host-accessible.
  struct ggml_context* ctx_host_vis = nullptr;
  struct ggml_tensor* host_patch_embd_w = nullptr;
  struct ggml_tensor* host_patch_embd_w1 = nullptr;
  struct ggml_tensor* host_position_embd = nullptr;

  // Cached host results of the vision patch-embed linear reshape (~1.5M-element
  // rearrange of the conv halves) and the exact-bilinear pos-embed table. Both
  // depend only on load-constant weights and the fixed patch geometry, so
  // they're computed on the first infer() and reused (re-uploaded) every later
  // call instead of being recomputed host-side each time. See phase 1.
  std::vector<float> vis_wlin_cache;
  std::vector<float> vis_pe_cache;
  bool vis_embed_cached = false;

  // Per-infer scratch, hoisted to members so the buffers are allocated once and
  // resized in place across calls instead of malloc/free'd every call.
  std::vector<float> scratch_vision; // nMerged·outHidden
  std::vector<std::vector<float>> scratch_deep;
  std::vector<float> scratch_embeds;   // nTok·hiddenDim
  std::vector<float> scratch_backbone; // nTok·hiddenDim
  std::vector<float> scratch_vl;       // nTok·hiddenDim

  // Cached structural attention masks. Valid iff the signature below (token
  // ids, valid-mask, counts) matches the current call — within a control
  // episode the prompt is fixed, so these hit every step after the first. The
  // match is an exact element compare, so a stale hit is impossible.
  std::vector<int32_t> mask_sig_tokens;
  std::vector<uint8_t> mask_sig_mask;
  int mask_sig_nTok = -1;
  int mask_sig_nImages = -1;
  bool masks_valid = false;
  std::vector<float> vis_mask_cache;  // nVpos·nVpos block-diagonal (phase 1)
  std::vector<float> text_mask_cache; // nTok·nTok causal (phase 2)
  std::vector<float> dit_im_cache;    // tTok·nTok cross-attn image (phase 4)
  std::vector<float> dit_tx_cache;    // tTok·nTok cross-attn text (phase 4)

  // Pre-transposed ([in,out]) copies of the CategorySpecificLinear weights.
  // grootLinearXW's runtime ggml_cont(ggml_transpose(w)) is otherwise
  // recomputed on every Euler step of every infer(); materializing them once at
  // load lets the state/DiT graphs use plain grootLinear. Resident in buf_wt
  // (device on the GPU path). wt_ready=false falls back to the
  // runtime-transpose path.
  struct ggml_context* ctx_wt = nullptr;
  ggml_backend_buffer_t buf_wt = nullptr;
  bool wt_ready = false;

  // Holds the selected embodiment's sliced 2-D/1-D CategorySpecificLinear
  // tensors, materialized from the multi-embodiment rank-3/2 GGUF tensors at
  // load (grootSliceEmbodiment). Null on v1 GGUFs (already 2-D on disk). Freed
  // before ctx_w, like buf_wt/ctx_wt.
  struct ggml_context* ctx_emb = nullptr;
  ggml_backend_buffer_t buf_emb = nullptr;
  // One entry per staged embodiment tensor (7 weights + 7 biases), recorded by
  // grootSliceEmbodiment so a row can be re-read later: `dst` is the sliced
  // ctx_emb tensor the graphs consume, `file_offset` the absolute byte offset
  // of the source tensor's row 0 in the GGUF, `row_bytes` one row's size (row
  // is the outermost axis, so each row's block is contiguous). Empty on v1
  // GGUFs.
  struct GrootEmbRowSlice {
    struct ggml_tensor* dst = nullptr;
    size_t file_offset = 0;
    size_t row_bytes = 0;
  };
  std::vector<GrootEmbRowSlice> emb_slices;
  // Serializes setEmbodiment against infer: infer runs on the framework's
  // JobRunner worker thread while setEmbodiment is called from the JS thread,
  // and setEmbodiment rewrites the very weights infer reads.
  std::mutex embodiment_mutex;
  // GPU path only: 32-byte-per-tensor PLACEHOLDER block for the
  // multi-embodiment rank-3 CategorySpecificLinear weights — not their bytes.
  // Giving them a non-null `data` is the whole mechanism that keeps every
  // shipped row's dead weight out of the GPU weight buffer, and it is all that
  // is needed, because only one row survives load and it is read from the file
  // directly into buf_emb. Freed as soon as the alloc has run. Empty on v1 /
  // CPU paths. See grootStageEmbodimentRowsHost.
  std::vector<uint8_t> emb_host_bytes;
  // The ctx_w tensors pointed at emb_host_bytes. Kept so those pointers can be
  // nulled once the alloc has consumed them — the tensors themselves outlive
  // the block in ctx_w and are orphaned (nothing ever reads them), so a null
  // deref beats a read of a 32-byte slot if that ever changes.
  std::vector<struct ggml_tensor*> emb_host_tensors;
  struct ggml_tensor* wt_se_l1 = nullptr; // state_encoder layer1/layer2
  struct ggml_tensor* wt_se_l2 = nullptr;
  struct ggml_tensor* wt_ae_w1 = nullptr; // action_encoder w1/w2/w3
  struct ggml_tensor* wt_ae_w2 = nullptr;
  struct ggml_tensor* wt_ae_w3 = nullptr;
  struct ggml_tensor* wt_ad_l1 = nullptr; // action_decoder layer1/layer2
  struct ggml_tensor* wt_ad_l2 = nullptr;

  // Per-phase scheduler/allocator caches, reused across infer() calls so the
  // ~14ms ggml_backend_sched_new (GPU) / gallocr setup is paid once per phase
  // for the life of the loaded model instead of every call. The graph and its
  // host-staging context are still rebuilt per call (no cross-call tensor
  // lifetime), so only the scheduler object persists. Freed in
  // GrootModel::~GrootModel (before the backends they reference are torn down).
  GrootSched sched_vision;
  GrootSched sched_tokemb;
  GrootSched sched_text;
  GrootSched sched_vlfusion;
  GrootSched sched_dit;

  ~GrootModelInternal() {
    // Free weight buffers FIRST — they back ctx_w's tensors.
    for (ggml_backend_buffer_t buf : bufs_w) {
      if (buf != nullptr) {
        ggml_backend_buffer_free(buf);
      }
    }
    bufs_w.clear();
    // buf_wt backs ctx_wt's transposed-weight tensors; free before the backend.
    if (buf_wt != nullptr) {
      ggml_backend_buffer_free(buf_wt);
      buf_wt = nullptr;
    }
    // buf_emb backs ctx_emb's sliced embodiment tensors; same ordering.
    if (buf_emb != nullptr) {
      ggml_backend_buffer_free(buf_emb);
      buf_emb = nullptr;
    }
    if (gguf != nullptr) {
      gguf_free(gguf);
      gguf = nullptr;
    }
    if (ctx_host_vis != nullptr) {
      ggml_free(ctx_host_vis);
      ctx_host_vis = nullptr;
    }
    if (ctx_wt != nullptr) {
      ggml_free(ctx_wt);
      ctx_wt = nullptr;
    }
    if (ctx_emb != nullptr) {
      ggml_free(ctx_emb);
      ctx_emb = nullptr;
    }
    if (ctx_w != nullptr) {
      ggml_free(ctx_w);
      ctx_w = nullptr;
    }
    if (backend != nullptr && backend != backend_cpu) {
      ggml_backend_free(backend);
    }
    if (backend_cpu != nullptr) {
      ggml_backend_free(backend_cpu);
    }
  }
};

namespace {

// ── Staged graph alloc + compute ────────────────────────────────────────────
// GR00T runs each infer phase (vision tower, text backbone, VL fusion, DiT) as
// a fresh graph. On the CPU path a `ggml_gallocr` gives lifetime-based buffer
// reuse (the mobile memory lever). On the GPU path a `ggml_backend_sched` over
// {gpu, cpu} places weighted ops on the GPU (weights are resident in device
// memory via the alloc+copy loader) and inserts host↔device copies for the
// input/output leaves. Mirrors smolvla's allocStagedSched/computeStaged and
// pi05's Pi05StagedGraph — groot was the last VLA still hardcoding CPU compute.
// (GrootSched is defined above GrootModelInternal, which caches one per phase.)

static void grootSchedFree(GrootSched& s);

// Allocate `gf` on the sched (GPU) or gallocr (CPU). Input leaves must be
// marked with `ggml_set_input` before this call and filled with
// `ggml_backend_tensor_set` afterwards. Returns false on any allocator failure.
static bool
grootSchedAlloc(GrootSched& s, GrootModelInternal& m, struct ggml_cgraph* gf) {
  const size_t gsize = ggml_graph_size(gf);
  if (m.has_gpu) {
    // Reuse a cached scheduler across calls (the ggml-backend.h canonical
    // pattern: reset → alloc_graph → compute). Rebuild only if a later graph
    // outgrows the capacity this sched was created with (shape change).
    if (s.sched != nullptr && gsize > s.graph_cap) {
      grootSchedFree(s);
    }
    if (s.sched == nullptr) {
      ggml_backend_t backends[2] = {m.backend, m.backend_cpu};
      // graph_size must cover n_nodes + n_leafs; the graph's capacity (always ≥
      // the built node/leaf count for these phases) is a safe upper bound.
      s.sched = ggml_backend_sched_new(
          backends,
          nullptr,
          2,
          gsize,
          /*parallel=*/false,
          /*op_offload=*/true);
      if (s.sched == nullptr) {
        return false;
      }
      s.graph_cap = gsize;
    } else {
      // Clear the previous graph's assignments before allocating this one.
      ggml_backend_sched_reset(s.sched);
    }
    // Free on alloc failure — otherwise it leaks on the OOM path (callers only
    // ggml_free their contexts on an alloc failure, not the sched/galloc),
    // which matters most on the mobile, memory-tight target this package
    // serves.
    if (!ggml_backend_sched_alloc_graph(s.sched, gf)) {
      grootSchedFree(s);
      return false;
    }
    return true;
  }
  // CPU path: a ggml_gallocr is designed to be re-allocated across graphs; keep
  // it cached too so repeated infer() calls reuse its buffer reservations.
  if (s.galloc == nullptr) {
    s.galloc =
        ggml_gallocr_new(ggml_backend_get_default_buffer_type(m.backend_cpu));
    if (s.galloc == nullptr) {
      return false;
    }
    s.graph_cap = gsize;
  }
  if (!ggml_gallocr_alloc_graph(s.galloc, gf)) {
    grootSchedFree(s);
    return false;
  }
  return true;
}

static bool grootSchedCompute(
    GrootSched& s, GrootModelInternal& m, struct ggml_cgraph* gf) {
  if (s.sched != nullptr) {
    return ggml_backend_sched_graph_compute(s.sched, gf) == GGML_STATUS_SUCCESS;
  }
  return ggml_backend_graph_compute(m.backend_cpu, gf) == GGML_STATUS_SUCCESS;
}

static void grootSchedFree(GrootSched& s) {
  if (s.sched != nullptr) {
    ggml_backend_sched_free(s.sched);
  }
  if (s.galloc != nullptr) {
    ggml_gallocr_free(s.galloc);
  }
  s = {};
}

// Upper sanity bound on how many embodiment rows a multi-embodiment GGUF may
// store. The full trained set is 17 rows today; 64 leaves room to grow while
// still rejecting a garbage row count before it sizes a host allocation or
// drives a row search. Checked against both the file's declared tensor
// dimension (staging + slicing) and its metadata table (resolution).
static constexpr int64_t GROOT_MAX_SANE_STORED_EMBODIMENTS = 64;

// alloc+copy weight loader (GPU path). Allocates a backend buffer of `buft` for
// every tensor metadata in ctx_w, then streams each tensor's bytes from the
// GGUF file into it via ggml_backend_tensor_set. Direct port of pi05's
// pi05LoadWeightsAllocCopy. Returns false so the caller can fall back to CPU.
// GPU path only: point the seven multi-embodiment CategorySpecificLinear
// weight+bias tensors (rank-3/2, all shipped rows) at a small placeholder block
// so the following GPU alloc skips them
// (ggml_backend_alloc_ctx_tensors_from_buft only allocates tensors with data ==
// nullptr). Only the load-time-selected row is ever used, and
// grootSliceEmbodiment reads it from the file, so this keeps every row's dead
// weight out of VRAM without ever materialising the bank in host RAM either —
// the placeholder holds no tensor data and the loader skips these tensors in
// its copy loop. No-op (leaves tensors on the normal GPU path) on v1 GGUFs,
// whose weights are already rank-2, if any tensor is absent, or without a
// usable ship-set table. Returns true if the tensors were staged.
static bool grootStageEmbodimentRowsHost(GrootModelInternal& m) {
  static const char* prefixes[7] = {
      "embodiment.state_encoder.layer1",
      "embodiment.state_encoder.layer2",
      "embodiment.action_encoder.w1",
      "embodiment.action_encoder.w2",
      "embodiment.action_encoder.w3",
      "embodiment.action_decoder.layer1",
      "embodiment.action_decoder.layer2"};
  struct ggml_tensor* ts[14];
  for (int i = 0; i < 7; ++i) {
    ts[2 * i] = ggml_get_tensor(
        m.ctx_w, (std::string(prefixes[i]) + ".weight").c_str());
    ts[2 * i + 1] =
        ggml_get_tensor(m.ctx_w, (std::string(prefixes[i]) + ".bias").c_str());
    if (ts[2 * i] == nullptr || ts[2 * i + 1] == nullptr) {
      return false; // unexpected layout — leave everything on the GPU path
    }
  }
  // Staging only pays off when there are unselected rows to keep out of VRAM.
  // A v1 GGUF (rank-2 on disk) and a one-row ship set both have ne[2] == 1, so
  // both stay on the normal GPU upload path. Tested on ne[2] rather than
  // ggml_n_dims because that collapses a one-row tensor's trailing singleton.
  if (ts[0]->ne[2] <= 1) {
    return false;
  }
  // The host block below is sized from all 14 tensors' declared dimensions, so
  // every row dim has to be bounded BEFORE anything is allocated: checking
  // ts[0] alone would still let a malformed later weight or bias declare an
  // arbitrary row count and drive the allocation. This is the same invariant
  // grootSliceEmbodiment enforces (table row count sane, selected row in range,
  // every tensor's row dim == the table's), hoisted ahead of the allocation —
  // grootResolveEmbodiment already ran, so both the table and the row are
  // known.
  const int64_t nStored =
      static_cast<int64_t>(m.embodiment_stored_cat_ids.size());
  if (m.selected_row < 0 || nStored <= 0) {
    return false; // no row to slice — leave everything on the GPU path
  }
  for (int i = 0; i < 7; ++i) {
    grootCheckEmbodimentSliceShape(
        ts[2 * i]->ne[2], ts[2 * i + 1]->ne[1], nStored, m.selected_row);
  }
  // The staged tensors' BYTES are never read: grootSliceEmbodiment allocates
  // fresh row-shaped tensors in ctx_emb and fills them straight from the file
  // (grootFillEmbodimentRow), so the full bank never has to exist in host RAM.
  // All this staging needs is a non-null `data`, which is the sole property
  // ggml_backend_alloc_ctx_tensors_from_buft tests to decide what to allocate.
  // So hand out distinct 32-byte placeholder slots rather than ggml_nbytes(t)
  // each: on the 17-row ship set a real block would be ~340MB of disk read,
  // ~340MB of fread copying and a ~340MB transient allocation per load, all of
  // it discarded unread. The loader must therefore SKIP these tensors in its
  // copy loop — it nulls the pointers as soon as the alloc has run so that a
  // stray read faults instead of running off a 32-byte slot.
  constexpr size_t kPlaceholderSlot = 32;
  m.emb_host_bytes.assign(kPlaceholderSlot * std::size(ts), 0);
  size_t off = 0;
  for (struct ggml_tensor* t : ts) {
    t->data = m.emb_host_bytes.data() + off; // excludes t from GPU alloc
    off += kPlaceholderSlot;
  }
  m.emb_host_tensors.assign(std::begin(ts), std::end(ts));
  return true;
}

static bool grootLoadWeightsAllocCopy(
    GrootModelInternal& m, const char* path, gguf_context* gguf,
    ggml_backend_buffer_type_t buft, size_t dataOffset,
    int64_t nTensorsInGguf) {
  // Keep the multi-embodiment rank-3 weights host-resident (out of VRAM); the
  // alloc below then skips them and the copy loop fills their host data
  // instead.
  grootStageEmbodimentRowsHost(m);
  ggml_backend_buffer_t buf =
      ggml_backend_alloc_ctx_tensors_from_buft(m.ctx_w, buft);
  if (buf == nullptr) {
    const char* bname = ggml_backend_name(m.backend);
    QLOG_IF(
        Priority::ERROR,
        std::string(
            "grootLoadModel: alloc_ctx_tensors_from_buft FAILED on "
            "backend '") +
            (bname != nullptr ? bname : "?") + "'");
    return false;
  }
  ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
  m.bufs_w.push_back(buf);

  // The placeholder pointers have served their only purpose (keeping these
  // tensors out of the alloc above). Null them before the copy loop so the loop
  // can recognise them, and so any later read of these orphaned rank-3 tensors
  // faults instead of running off a 32-byte slot. Nothing consumes their bytes:
  // grootSliceEmbodiment reads the selected row from the file.
  for (struct ggml_tensor* t : m.emb_host_tensors) {
    if (t != nullptr) {
      t->data = nullptr;
    }
  }
  std::vector<uint8_t>().swap(m.emb_host_bytes);

  FILE* f = std::fopen(path, "rb");
  if (f == nullptr) {
    return false;
  }
  std::vector<uint8_t> readBuf;
  int nCopied = 0;
  int nSkipped = 0;
  for (int64_t i = 0; i < nTensorsInGguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(m.ctx_w, name);
    if (t == nullptr) {
      continue;
    }
    const size_t off = dataOffset + gguf_get_tensor_offset(gguf, i);
    const size_t nbytes = ggml_nbytes(t);
    // Embodiment rows staged by grootStageEmbodimentRowsHost: excluded from the
    // alloc above, then nulled, so they are the only tensors left with neither
    // a backend buffer nor data. Their bytes are dead — grootSliceEmbodiment
    // reads the one selected row straight from the file — so skip them entirely
    // rather than reading the whole bank (~340MB on the 17-row ship set) to
    // discard it. Skipping also keeps readBuf sized to the largest UPLOADED
    // tensor: these are the biggest tensors in the file, so counting them would
    // strand that capacity for the rest of the load.
    if (t->buffer == nullptr && t->data == nullptr) {
      nSkipped++;
      continue;
    }
    if (readBuf.size() < nbytes) {
      readBuf.resize(nbytes);
    }
#ifdef _WIN32
    const int seekErr = _fseeki64(f, static_cast<int64_t>(off), SEEK_SET);
#else
    const int seekErr = fseeko(f, static_cast<off_t>(off), SEEK_SET);
#endif
    if (seekErr != 0 || std::fread(readBuf.data(), 1, nbytes, f) != nbytes) {
      QLOG_IF(
          Priority::ERROR,
          std::string("grootLoadModel: failed to read tensor '") + name + "'");
      std::fclose(f);
      return false;
    }
    ggml_backend_tensor_set(t, readBuf.data(), 0, nbytes);
    nCopied++;
  }
  std::fclose(f);
  const char* bname = ggml_backend_name(m.backend);
  QLOG_IF(
      Priority::INFO,
      "grootLoadModel: alloc+copy buffer ready, " + std::to_string(nCopied) +
          " tensors uploaded, " + std::to_string(nSkipped) +
          " unselected embodiment rows skipped, backend='" +
          (bname != nullptr ? bname : "?") + "'");
  return true;
}

// Read one named GGUF tensor's raw bytes into a fresh host-resident copy in
// `dst` (a no_alloc=false context). Used on the GPU path for the three vision
// weights infer() dereferences host-side. Returns nullptr on any error.
static struct ggml_tensor* grootHostCopyTensor(
    struct ggml_context* dst, const char* path, gguf_context* gguf,
    struct ggml_context* meta, size_t dataOffset, const char* name) {
  struct ggml_tensor* src = ggml_get_tensor(meta, name);
  if (src == nullptr) {
    return nullptr;
  }
  struct ggml_tensor* h = ggml_dup_tensor(dst, src); // host buffer, data valid
  if (h == nullptr) {
    return nullptr;
  }
  ggml_set_name(h, name);
  const int64_t idx = gguf_find_tensor(gguf, name);
  if (idx < 0) {
    return nullptr;
  }
  const size_t off = dataOffset + gguf_get_tensor_offset(gguf, idx);
  const size_t nbytes = ggml_nbytes(h);
  FILE* f = std::fopen(path, "rb");
  if (f == nullptr) {
    return nullptr;
  }
#ifdef _WIN32
  const int seekErr = _fseeki64(f, static_cast<int64_t>(off), SEEK_SET);
#else
  const int seekErr = fseeko(f, static_cast<off_t>(off), SEEK_SET);
#endif
  if (seekErr != 0 || std::fread(h->data, 1, nbytes, f) != nbytes) {
    std::fclose(f);
    return nullptr;
  }
  std::fclose(f);
  return h;
}

float ggufGetF32Or(struct gguf_context* g, const char* key, float dflt) {
  const int64_t idx = gguf_find_key(g, key);
  if (idx < 0) {
    return dflt;
  }
  if (gguf_get_kv_type(g, idx) != GGUF_TYPE_FLOAT32) {
    return dflt;
  }
  return gguf_get_val_f32(g, idx);
}

std::vector<std::string> ggufGetStrArrOr(
    struct gguf_context* g, const char* key, std::vector<std::string> dflt) {
  const int64_t idx = gguf_find_key(g, key);
  if (idx < 0 || gguf_get_kv_type(g, idx) != GGUF_TYPE_ARRAY ||
      gguf_get_arr_type(g, idx) != GGUF_TYPE_STRING) {
    return dflt;
  }
  const size_t n = gguf_get_arr_n(g, idx);
  std::vector<std::string> out;
  out.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    out.emplace_back(gguf_get_arr_str(g, idx, i));
  }
  return out;
}

} // namespace

// Externally visible (declared in groot.hpp) rather than sharing the anonymous
// namespace above, so the corrupt-metadata path is unit-testable.
std::vector<int> ggufGetI32ArrOr(
    struct gguf_context* g, const char* key, std::vector<int> dflt) {
  const int64_t idx = gguf_find_key(g, key);
  if (idx < 0) {
    return dflt; // key absent — legitimately an older/v1 GGUF
  }
  // Present but unreadable is corruption, not an older file: falling back to
  // the default would silently discard a ship-set table the tensors are still
  // shaped for, and the mismatch only surfaces much later (see
  // grootCheckV1EmbodimentRank).
  if (gguf_get_kv_type(g, idx) != GGUF_TYPE_ARRAY) {
    throw std::runtime_error(
        std::string("ggufGetI32ArrOr: '") + key +
        "' is present but is not an array");
  }
  if (gguf_get_arr_type(g, idx) != GGUF_TYPE_INT32) {
    throw std::runtime_error(
        std::string("ggufGetI32ArrOr: '") + key +
        "' is present but is not an int32 array (type " +
        std::to_string(static_cast<int>(gguf_get_arr_type(g, idx))) + ")");
  }
  const size_t n = gguf_get_arr_n(g, idx);
  const int32_t* data = static_cast<const int32_t*>(gguf_get_arr_data(g, idx));
  return std::vector<int>(data, data + n);
}

void grootCheckV1EmbodimentRank(int64_t weightRowDim) {
  if (weightRowDim > 1) {
    throw std::runtime_error(
        "grootCheckV1EmbodimentRank: embodiment weights store " +
        std::to_string(weightRowDim) +
        " rows but no readable groot.embodiment.stored_cat_ids table — cannot "
        "tell which row to use");
  }
}

void grootCheckEmbodimentCount(size_t declaredCount, size_t tableRows) {
  if (declaredCount != tableRows) {
    throw std::runtime_error(
        "grootCheckEmbodimentCount: groot.embodiment.count is " +
        std::to_string(declaredCount) + " but the stored_cat_ids table holds " +
        std::to_string(tableRows) + " rows");
  }
}

size_t
grootEmbodimentRowOffset(size_t fileOffset, int rowIndex, size_t rowBytes) {
  const size_t rows = static_cast<size_t>(rowIndex);
  const size_t rowOff = rows * rowBytes;
  if ((rowBytes != 0 && rowOff / rowBytes != rows) ||
      fileOffset > SIZE_MAX - rowOff) {
    throw std::runtime_error(
        "grootEmbodimentRowOffset: embodiment row offset overflows for row " +
        std::to_string(rowIndex));
  }
  return fileOffset + rowOff;
}

// The seven per-embodiment weights whose transposed copies live in ctx_wt, in
// the fixed order the wt_* members are declared. Shared by the alloc and fill
// halves below so the two can never drift out of correspondence.
static void
grootEmbodimentWeightSrcs(GrootModelInternal& m, struct ggml_tensor* srcs[7]) {
  srcs[0] = m.embodiment.state_encoder_layer1.weight;
  srcs[1] = m.embodiment.state_encoder_layer2.weight;
  srcs[2] = m.embodiment.action_encoder_w1.weight;
  srcs[3] = m.embodiment.action_encoder_w2.weight;
  srcs[4] = m.embodiment.action_encoder_w3.weight;
  srcs[5] = m.embodiment.action_decoder_layer1.weight;
  srcs[6] = m.embodiment.action_decoder_layer2.weight;
}

// Host scratch one transpose pass needs: the largest of the seven weights,
// since the pass reuses one src/dst buffer pair across all of them.
static size_t grootTransposedScratchBytes(GrootModelInternal& m) {
  struct ggml_tensor* srcs[7];
  grootEmbodimentWeightSrcs(m, srcs);
  size_t maxNb = 0;
  for (struct ggml_tensor* s : srcs) {
    if (s != nullptr) {
      maxNb = std::max(maxNb, ggml_nbytes(s));
    }
  }
  return maxNb;
}

// Fill (or refill) the transposed copies from the CURRENT embodiment weights.
// Split out of the allocation below because setEmbodiment swaps the source
// row's values without changing any shape: the ctx_wt tensors and buf_wt stay
// exactly as allocated at load and only their contents are rewritten.
//
// `src8`/`dst8` are caller-owned scratch, each at least
// grootTransposedScratchBytes(m). Taking them pre-sized rather than growing
// them here is what makes the refill infallible once it starts writing:
// setEmbodiment allocates them BEFORE it commits the new embodiment row, so a
// bad_alloc can only happen while the model is still wholly on the previous
// embodiment. A short buffer is a programming error and is rejected before the
// first write.
// `need` is the scratch size the caller sized src8/dst8 from. It is passed in
// rather than recomputed here so that the only step that can reject the buffers
// happens BEFORE setEmbodiment commits a new row — recomputing it here would
// put the one fallible check on the far side of the first write, and a throw
// there would leave buf_emb on the new row while ctx_wt still held the old
// row's transposes.
static void grootFillTransposedWeights(
    GrootModelInternal& m, std::vector<uint8_t>& src8,
    std::vector<uint8_t>& dst8, size_t need) {
  struct ggml_tensor* srcs[7];
  grootEmbodimentWeightSrcs(m, srcs);
  struct ggml_tensor* dsts[7] = {
      m.wt_se_l1,
      m.wt_se_l2,
      m.wt_ae_w1,
      m.wt_ae_w2,
      m.wt_ae_w3,
      m.wt_ad_l1,
      m.wt_ad_l2};
  if (src8.size() < need || dst8.size() < need) {
    throw std::runtime_error(
        "grootFillTransposedWeights: scratch buffers are smaller than the "
        "largest embodiment weight");
  }
  // dst[ii + nIn*oi] = src[oi + nOut*ii] — plain 2-D element transpose, typed
  // on the element width so each element is an inline load/store. A std::memcpy
  // of a RUNTIME size (2 bytes for F16, 4 for F32) can't be folded into a move,
  // and at HIDDEN_SIZE=1024 most of these matrices are ~1024x1024, so the
  // untyped version cost ~5M out-of-line calls per refill — on setEmbodiment's
  // path, under the embodiment_mutex, on the JS thread.
  auto transpose = [](auto* dst, const auto* src, int64_t nOut, int64_t nIn) {
    for (int64_t oi = 0; oi < nOut; ++oi) {
      for (int64_t ii = 0; ii < nIn; ++ii) {
        dst[oi * nIn + ii] = src[ii * nOut + oi];
      }
    }
  };
  for (int i = 0; i < 7; ++i) {
    struct ggml_tensor* s = srcs[i];
    const int64_t nOut = s->ne[0];
    const int64_t nIn = s->ne[1];
    const size_t es = ggml_type_size(s->type);
    const size_t nb = ggml_nbytes(s);
    // CPU mmap path: tensors carry a host `data` pointer but no backend buffer,
    // so read it directly; GPU path: pull the device-resident bytes to host.
    if (s->buffer != nullptr) {
      ggml_backend_tensor_get(s, src8.data(), 0, nb);
    } else {
      std::memcpy(src8.data(), s->data, nb);
    }
    // grootMaterializeTransposedWeights admits only F32/F16 sources, so the
    // element width is 4 or 2; anything else would be a caller bug.
    if (es == sizeof(uint32_t)) {
      transpose(
          reinterpret_cast<uint32_t*>(dst8.data()),
          reinterpret_cast<const uint32_t*>(src8.data()),
          nOut,
          nIn);
    } else if (es == sizeof(uint16_t)) {
      transpose(
          reinterpret_cast<uint16_t*>(dst8.data()),
          reinterpret_cast<const uint16_t*>(src8.data()),
          nOut,
          nIn);
    } else {
      throw std::runtime_error(
          "grootFillTransposedWeights: unsupported element size " +
          std::to_string(es));
    }
    ggml_backend_tensor_set(dsts[i], dst8.data(), 0, nb);
  }
}

// Materialize transposed ([in,out]) copies of the seven CategorySpecificLinear
// weights once at load, so the state/DiT graphs can use plain grootLinear
// instead of grootLinearXW's per-step ggml_cont(ggml_transpose(w)). The
// quantizer keeps these weights F16/F32 (a transposed-cont of a quantized
// tensor is unsupported), so the transpose is a plain element reorder, giving
// results bit-identical to the runtime cont. On any unexpected shape/type the
// function bails and leaves wt_ready=false → infer() keeps the original path.
static bool grootMaterializeTransposedWeights(GrootModelInternal& m) {
  struct ggml_tensor* srcs[7];
  grootEmbodimentWeightSrcs(m, srcs);
  for (struct ggml_tensor* s : srcs) {
    if (s == nullptr || ggml_n_dims(s) != 2 || !ggml_is_contiguous(s) ||
        (s->type != GGML_TYPE_F32 && s->type != GGML_TYPE_F16)) {
      return false; // keep the runtime-transpose path
    }
  }
  struct ggml_init_params ip{
      ggml_tensor_overhead() * 8 + 256, nullptr, /*no_alloc=*/true};
  m.ctx_wt = ggml_init(ip);
  if (m.ctx_wt == nullptr) {
    return false;
  }
  struct ggml_tensor** dsts[7] = {
      &m.wt_se_l1,
      &m.wt_se_l2,
      &m.wt_ae_w1,
      &m.wt_ae_w2,
      &m.wt_ae_w3,
      &m.wt_ad_l1,
      &m.wt_ad_l2};
  for (int i = 0; i < 7; ++i) {
    // src ne=[out,in] → transposed ne=[in,out].
    *dsts[i] = ggml_new_tensor_2d(
        m.ctx_wt, srcs[i]->type, srcs[i]->ne[1], srcs[i]->ne[0]);
    if (*dsts[i] == nullptr) {
      return false;
    }
  }
  ggml_backend_buffer_type_t buft =
      ggml_backend_get_default_buffer_type(m.backend);
  m.buf_wt = ggml_backend_alloc_ctx_tensors_from_buft(m.ctx_wt, buft);
  if (m.buf_wt == nullptr) {
    return false;
  }
  ggml_backend_buffer_set_usage(m.buf_wt, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
  const size_t scratch = grootTransposedScratchBytes(m);
  std::vector<uint8_t> src8(scratch);
  std::vector<uint8_t> dst8(scratch);
  grootFillTransposedWeights(m, src8, dst8, scratch);
  m.wt_ready = true;
  return true;
}

// Copy embodiment row `rowIndex` into the sliced ctx_emb tensors, from the GGUF
// file. The file (not the rank-3 ctx_w tensors) is the source because those
// sources do not survive load on the GPU path: their host staging is released
// and their data pointers nulled once the first row is sliced. Reading them
// back from disk instead keeps the unselected rows out of both VRAM and host
// RAM at the cost of one row's worth of I/O (~20MB on the 17-row ship set),
// which is what makes setEmbodiment cheap enough to be worth having.
//
// Each row's block is contiguous (row = outermost ggml axis), so the byte
// offset is rowIndex * one-row size, and one row's size is exactly the dst's
// nbytes. Caller must have validated rowIndex against the table
// (grootSliceEmbodiment).
//
// ALL 14 blocks are read into host memory before ANY tensor is written, so a
// failure partway through cannot leave the model mixing two embodiments'
// weights while selected_* still names the old one. Only the write pass touches
// the model, and it cannot fail. The staging costs one row, ~20MB on the 17-row
// ship set, held for the duration of the call.
static void grootFillEmbodimentRow(GrootModelInternal& m, int rowIndex) {
  size_t total = 0;
  for (const GrootModelInternal::GrootEmbRowSlice& sl : m.emb_slices) {
    total += sl.row_bytes; // sum of live allocations: cannot overflow
  }
  std::vector<uint8_t> staged(total);

  FILE* f = std::fopen(m.gguf_path.c_str(), "rb");
  if (f == nullptr) {
    throw std::runtime_error(
        "grootFillEmbodimentRow: cannot reopen '" + m.gguf_path + "'");
  }
  size_t stagedOff = 0;
  for (const GrootModelInternal::GrootEmbRowSlice& sl : m.emb_slices) {
    // Bounded rather than trusted, since row_bytes derives from GGUF-declared
    // dims. Wrapped in a try so the FILE* is closed on the throw path.
    size_t off = 0;
    try {
      off = grootEmbodimentRowOffset(sl.file_offset, rowIndex, sl.row_bytes);
    } catch (...) {
      std::fclose(f);
      throw;
    }
#ifdef _WIN32
    const int seekErr = _fseeki64(f, static_cast<int64_t>(off), SEEK_SET);
#else
    const int seekErr = fseeko(f, static_cast<off_t>(off), SEEK_SET);
#endif
    if (seekErr != 0 ||
        std::fread(staged.data() + stagedOff, 1, sl.row_bytes, f) !=
            sl.row_bytes) {
      std::fclose(f);
      throw std::runtime_error(
          "grootFillEmbodimentRow: short read for embodiment row " +
          std::to_string(rowIndex) + " of '" + m.gguf_path + "'");
    }
    stagedOff += sl.row_bytes;
  }
  std::fclose(f);

  stagedOff = 0;
  for (const GrootModelInternal::GrootEmbRowSlice& sl : m.emb_slices) {
    ggml_backend_tensor_set(sl.dst, staged.data() + stagedOff, 0, sl.row_bytes);
    stagedOff += sl.row_bytes;
  }
}

// Slice the seven CategorySpecificLinear tensors to one embodiment row, so the
// pre-transpose + graph builders below operate on plain 2-D/1-D weights exactly
// as they do for a v1 single-embodiment GGUF. Multi GGUFs store them with the
// row (category) dim kept: weight ne=[out,in,n_stored] (row = OUTERMOST ggml
// axis → each row's [out,in] block is contiguous), bias ne=[out,n_stored]. We
// allocate fresh 2-D/1-D tensors in ctx_emb and fill them with row `rowIndex`
// via grootFillEmbodimentRow, which setEmbodiment reuses to swap rows later.
// v1 GGUFs (rowIndex -1, weights already sliced on disk) are left untouched.
// Throws on a malformed multi GGUF — the fallback path can't consume a stored
// weight, so this must be fatal rather than silently degrade.
static void grootSliceEmbodiment(GrootModelInternal& m, int rowIndex) {
  GrootLinearWeights* lins[7] = {
      &m.embodiment.state_encoder_layer1,
      &m.embodiment.state_encoder_layer2,
      &m.embodiment.action_encoder_w1,
      &m.embodiment.action_encoder_w2,
      &m.embodiment.action_encoder_w3,
      &m.embodiment.action_decoder_layer1,
      &m.embodiment.action_decoder_layer2};

  // Whether there is a row to slice comes from the resolver's decision, NOT
  // from the tensors' apparent rank: a one-row ship set stores ne=[out,in,1]
  // and ggml_n_dims collapses that trailing singleton, so a rank test would
  // read a perfectly valid one-row multi GGUF as an already-sliced v1 weight
  // and reject it. grootCheckEmbodimentSliceShape does the metadata-vs-tensor
  // agreement check below instead.
  if (rowIndex < 0 || lins[0]->weight == nullptr) {
    // No row to slice means the resolver saw no ship-set table, i.e. this must
    // be a v1 GGUF whose weights are already one embodiment. Assert that rather
    // than assume it — see grootCheckV1EmbodimentRank for why the alternative
    // is a process abort on the first infer rather than a load failure.
    if (rowIndex < 0 && lins[0]->weight != nullptr) {
      grootCheckV1EmbodimentRank(lins[0]->weight->ne[2]);
    }
    return;
  }
  const int64_t nStored =
      static_cast<int64_t>(m.embodiment_stored_cat_ids.size());

  struct ggml_init_params ip{
      ggml_tensor_overhead() * 16 + 256, nullptr, /*no_alloc=*/true};
  m.ctx_emb = ggml_init(ip);
  if (m.ctx_emb == nullptr) {
    throw std::runtime_error("grootSliceEmbodiment: ctx_emb alloc failed");
  }

  // Validate + allocate dst tensors, recording each one's source row geometry
  // in the GGUF so grootFillEmbodimentRow can (re-)read any row later.
  const size_t dataOffset = gguf_get_data_offset(m.gguf);
  m.emb_slices.clear();
  m.emb_slices.reserve(14);
  auto recordSlice = [&](struct ggml_tensor* src, struct ggml_tensor* dst) {
    const int64_t ti = gguf_find_tensor(m.gguf, ggml_get_name(src));
    if (ti < 0) {
      throw std::runtime_error(
          std::string("grootSliceEmbodiment: '") + ggml_get_name(src) +
          "' is not a GGUF tensor");
    }
    m.emb_slices.push_back(
        {dst,
         dataOffset + gguf_get_tensor_offset(m.gguf, ti),
         ggml_nbytes(dst)});
  };
  for (GrootLinearWeights* l : lins) {
    struct ggml_tensor* w = l->weight;
    struct ggml_tensor* b = l->bias;
    if (w == nullptr || b == nullptr) {
      throw std::runtime_error(
          "grootSliceEmbodiment: missing multi-embodiment weight/bias tensor");
    }
    // Row dims vs the embodiment table; also bounds rowIndex and nStored.
    grootCheckEmbodimentSliceShape(w->ne[2], b->ne[1], nStored, rowIndex);
    // weight: ne=[out,in,n_stored] → dst ne=[out,in].
    if (!ggml_is_contiguous(w) || w->ne[3] != 1 ||
        (w->type != GGML_TYPE_F32 && w->type != GGML_TYPE_F16)) {
      throw std::runtime_error(
          "grootSliceEmbodiment: malformed multi-embodiment weight tensor");
    }
    struct ggml_tensor* wd =
        ggml_new_tensor_2d(m.ctx_emb, w->type, w->ne[0], w->ne[1]);
    recordSlice(w, wd);
    l->weight = wd;
    // bias: ne=[out,n_stored] → dst ne=[out].
    if (!ggml_is_contiguous(b) || b->ne[2] != 1 || b->ne[3] != 1 ||
        (b->type != GGML_TYPE_F32 && b->type != GGML_TYPE_F16)) {
      throw std::runtime_error(
          "grootSliceEmbodiment: malformed multi-embodiment bias tensor");
    }
    struct ggml_tensor* bd = ggml_new_tensor_1d(m.ctx_emb, b->type, b->ne[0]);
    recordSlice(b, bd);
    l->bias = bd;
  }

  ggml_backend_buffer_type_t buft =
      ggml_backend_get_default_buffer_type(m.backend);
  m.buf_emb = ggml_backend_alloc_ctx_tensors_from_buft(m.ctx_emb, buft);
  if (m.buf_emb == nullptr) {
    throw std::runtime_error("grootSliceEmbodiment: buf_emb alloc failed");
  }
  ggml_backend_buffer_set_usage(m.buf_emb, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);

  grootFillEmbodimentRow(m, rowIndex);
}

// Runs grootSliceEmbodiment's two table-vs-tensor agreement checks EARLY, from
// the load path, before mustGet demands that every model tensor exist.
//
// Both checks read nothing but ggml `ne` extents, which a GGUF declares in its
// tensor-info block. Hoisting them here is therefore not just fail-fast: it is
// what makes them reachable from a metadata-only GGUF of a few KB, written with
// gguf_init_empty + gguf_add_tensor, instead of demanding a purpose-built
// multi-GB fixture carrying every shared weight. The rejections a corrupt file
// gets are unchanged.
//
// Probes the first embodiment linear only. The per-tensor loop in
// grootSliceEmbodiment still checks all seven, and is also the path
// setEmbodiment re-enters later, so both stay. An absent probe tensor is left
// for mustGet to name — a missing weight is its error to report, not a rank
// mismatch.
static void grootCheckEmbodimentTensorRankEarly(GrootModelInternal& m) {
  struct ggml_tensor* w =
      ggml_get_tensor(m.ctx_w, "embodiment.state_encoder.layer1.weight");
  struct ggml_tensor* b =
      ggml_get_tensor(m.ctx_w, "embodiment.state_encoder.layer1.bias");
  if (w == nullptr || b == nullptr) {
    return;
  }
  // selected_row < 0 means the resolver found no usable ship-set table, so the
  // weights have to already be one row.
  if (m.selected_row < 0) {
    grootCheckV1EmbodimentRank(w->ne[2]);
    return;
  }
  grootCheckEmbodimentSliceShape(
      w->ne[2],
      b->ne[1],
      static_cast<int64_t>(m.embodiment_stored_cat_ids.size()),
      m.selected_row);
}

// Upper sanity bound on a resolved embodiment's camera count. Real GR00T
// embodiments use 2 (LIBERO) to 4 (DROID); 64 is a generous ceiling that still
// rejects a garbage/uninitialised metadata value before it reaches the graph.
static constexpr int GROOT_MAX_SANE_NUM_CAMERAS = 64;

// Largest selectable embodiment id. A cat_id indexes GR00T's
// CategorySpecificLinear bank, whose category dim the architecture fixes at
// `max_num_embodiments` = 32, so 0..31 is the whole id space — anything above
// it cannot name a row in any conversion of any checkpoint. Bounding it here
// keeps an out-of-range id a named error instead of a "not in this ship set"
// one, and stops a caller's id from having to survive an int32 narrowing on the
// way in.
static constexpr int GROOT_MAX_EMBODIMENT_CAT_ID = 31;

void grootCheckEmbodimentSliceShape(
    int64_t weightRowDim, int64_t biasRowDim, int64_t nStored, int rowIndex) {
  if (nStored <= 0 || nStored > GROOT_MAX_SANE_STORED_EMBODIMENTS) {
    throw std::runtime_error(
        "grootCheckEmbodimentSliceShape: embodiment table declares " +
        std::to_string(nStored) + " stored rows (expected 1.." +
        std::to_string(GROOT_MAX_SANE_STORED_EMBODIMENTS) + ")");
  }
  if (rowIndex < 0 || rowIndex >= nStored) {
    throw std::runtime_error(
        "grootCheckEmbodimentSliceShape: selected row " +
        std::to_string(rowIndex) + " is out of range for " +
        std::to_string(nStored) + " stored rows");
  }
  if (weightRowDim != nStored || biasRowDim != nStored) {
    throw std::runtime_error(
        "grootCheckEmbodimentSliceShape: embodiment table says " +
        std::to_string(nStored) + " stored rows but the tensors carry " +
        std::to_string(weightRowDim) + " (weight) / " +
        std::to_string(biasRowDim) + " (bias) — GGUF metadata/tensor mismatch");
  }
}

GrootEmbodimentSelection grootResolveEmbodiment(
    const std::vector<std::string>& tags, const std::vector<int>& catIds,
    const std::vector<int>& storedCatIds,
    const std::vector<int>& storedNumCameras, const std::string& bakedTag,
    int bakedCatId, const std::string& defaultTag,
    const VlaEmbodimentRequest& request, int defaultNumCameras) {
  const bool isMulti = !storedCatIds.empty();
  // A tag and a cat_id are two spellings of one selection, so honouring a
  // precedence between them would silently hand back the embodiment the caller
  // did not name. Reject instead.
  if (!request.tag.empty() && request.cat_id >= 0) {
    throw std::runtime_error(
        "grootResolveEmbodiment: request carries both a tag ('" + request.tag +
        "') and a cat_id (" + std::to_string(request.cat_id) +
        ") — pass exactly one");
  }
  if (request.num_cameras > GROOT_MAX_SANE_NUM_CAMERAS) {
    throw std::runtime_error(
        "grootResolveEmbodiment: requested num_cameras " +
        std::to_string(request.num_cameras) + " is out of range (1.." +
        std::to_string(GROOT_MAX_SANE_NUM_CAMERAS) + ")");
  }
  if (request.cat_id > GROOT_MAX_EMBODIMENT_CAT_ID) {
    throw std::runtime_error(
        "grootResolveEmbodiment: requested cat_id " +
        std::to_string(request.cat_id) + " is out of range (0.." +
        std::to_string(GROOT_MAX_EMBODIMENT_CAT_ID) + ")");
  }
  // Explicit tag wins, else the GGUF default — but a cat_id request resolves
  // numerically and must not fall back to the default tag.
  const std::string wantTag =
      !request.tag.empty() ? request.tag
                           : (request.cat_id >= 0 ? std::string() : defaultTag);

  GrootEmbodimentSelection sel{};
  // The count the GGUF itself knows for the selected embodiment; 0 = unknown,
  // which only an explicit request.num_cameras can rescue (see below).
  int knownCams = 0;

  if (!isMulti) {
    // v1 single-embodiment GGUF: only the baked entry is selectable, by either
    // spelling of it.
    if (!request.tag.empty() && request.tag != bakedTag) {
      throw std::runtime_error(
          "grootResolveEmbodiment: GGUF is single-embodiment ('" + bakedTag +
          "'); cannot select '" + request.tag + "'");
    }
    if (request.cat_id >= 0 && request.cat_id != bakedCatId) {
      throw std::runtime_error(
          "grootResolveEmbodiment: GGUF is single-embodiment (cat_id " +
          std::to_string(bakedCatId) + "); cannot select cat_id " +
          std::to_string(request.cat_id));
    }
    sel.tag = bakedTag;
    sel.cat_id = bakedCatId;
    sel.row = -1; // no slice; weights are already 2-D on disk
    knownCams = defaultNumCameras;
  } else {
    // A ship set larger than any converter can emit means a corrupt table;
    // reject it here rather than let it drive a row search and, on the GPU
    // path, a host allocation sized from the matching tensor dimension.
    if (storedCatIds.size() >
        static_cast<size_t>(GROOT_MAX_SANE_STORED_EMBODIMENTS)) {
      throw std::runtime_error(
          "grootResolveEmbodiment: embodiment table declares " +
          std::to_string(storedCatIds.size()) + " stored rows (max " +
          std::to_string(GROOT_MAX_SANE_STORED_EMBODIMENTS) + ")");
    }
    // Resolve wantTag -> cat_id via the full map (fall back to the baked cat_id
    // when the map is absent and wantTag is the baked tag).
    if (tags.size() != catIds.size()) {
      throw std::runtime_error(
          "grootResolveEmbodiment: malformed embodiment table — tags (" +
          std::to_string(tags.size()) + ") and cat_ids (" +
          std::to_string(catIds.size()) + ") length mismatch");
    }
    int wantCatId = request.cat_id;
    if (wantCatId < 0) {
      for (size_t i = 0; i < tags.size(); ++i) {
        if (tags[i] == wantTag) {
          wantCatId = catIds[i];
          break;
        }
      }
      if (wantCatId < 0 && wantTag == bakedTag) {
        wantCatId = bakedCatId;
      }
      if (wantCatId < 0) {
        throw std::runtime_error(
            "grootResolveEmbodiment: unknown embodiment tag '" + wantTag + "'");
      }
    }
    // Selection by cat_id still reports a tag, so hparams stays readable and a
    // caller can round-trip id -> tag. Many tags alias one cat_id; the first in
    // the map is the canonical spelling. A cat_id absent from the map (possible
    // on a ship set converted from a checkpoint whose tag map is narrower than
    // its trained rows) gets a synthetic name rather than an empty one.
    std::string reportTag = wantTag;
    if (reportTag.empty()) {
      for (size_t i = 0; i < catIds.size(); ++i) {
        if (catIds[i] == wantCatId) {
          reportTag = tags[i];
          break;
        }
      }
      if (reportTag.empty()) {
        reportTag = "cat_id_" + std::to_string(wantCatId);
      }
    }
    // cat_id -> stored row.
    int row = -1;
    for (size_t i = 0; i < storedCatIds.size(); ++i) {
      if (storedCatIds[i] == wantCatId) {
        row = static_cast<int>(i);
        break;
      }
    }
    if (row < 0) {
      throw std::runtime_error(
          "grootResolveEmbodiment: embodiment '" + reportTag + "' (cat_id " +
          std::to_string(wantCatId) +
          ") is not stored in this GGUF's ship set");
    }
    sel.tag = reportTag;
    sel.cat_id = wantCatId;
    sel.row = row;
    // Per-row num_cameras is authoritative for a multi GGUF — NOT the top-level
    // default, which describes only the default embodiment. A stored count of 0
    // means this embodiment's view count was unknown at conversion time
    // (num_cameras is a data-config property, absent from the checkpoint), and
    // inheriting a different embodiment's count would build the wrong
    // image-token layout and infer silently wrong. Such a row is runnable only
    // if the caller states the count.
    knownCams = row < static_cast<int>(storedNumCameras.size())
                    ? storedNumCameras[row]
                    : 0;
  }
  if (request.num_cameras > 0) {
    // The caller's count wins even when the GGUF has one: counts are stored per
    // cat_id, so tags aliasing one cat_id share a count and a rig with a
    // different view count has no other way to be run. Log the disagreement so
    // a mistyped override is visible in the run log.
    if (knownCams > 0 && knownCams != request.num_cameras) {
      QLOG_IF(
          Priority::WARNING,
          "grootResolveEmbodiment: embodiment '" + sel.tag +
              "' overrides the GGUF's num_cameras " +
              std::to_string(knownCams) + " with " +
              std::to_string(request.num_cameras));
    }
    sel.num_cameras = request.num_cameras;
  } else {
    if (knownCams <= 0) {
      throw std::runtime_error(
          "grootResolveEmbodiment: embodiment '" + sel.tag + "' (cat_id " +
          std::to_string(sel.cat_id) +
          ") has no known num_cameras in this GGUF — pass an explicit "
          "num_cameras to select it");
    }
    sel.num_cameras = knownCams;
  }
  if (sel.num_cameras <= 0 || sel.num_cameras > GROOT_MAX_SANE_NUM_CAMERAS) {
    throw std::runtime_error(
        "grootResolveEmbodiment: num_cameras for embodiment '" + sel.tag +
        "' is unknown/invalid — this embodiment needs an explicit num_cameras");
  }
  return sel;
}

// Resolve `request` (unset = the GGUF's default) against this model's
// embodiment tables. Shared by the load path and setEmbodiment so both apply
// identical rules — in particular the camera fallback reads the file's own
// num_cameras
// (`gguf_default_num_cameras`), not the currently selected embodiment's count,
// which setEmbodiment overwrites.
static GrootEmbodimentSelection grootResolveForModel(
    GrootModelInternal& m, const VlaEmbodimentRequest& request) {
  const std::string defaultTag =
      ggufGetStrOr(m.gguf, "groot.embodiment.default", m.embodiment_tag);
  return grootResolveEmbodiment(
      m.embodiment_tags,
      m.embodiment_cat_ids,
      m.embodiment_stored_cat_ids,
      m.embodiment_stored_num_cameras,
      m.embodiment_tag,
      m.embodiment_cat_id,
      defaultTag,
      request,
      m.gguf_default_num_cameras);
}

static std::unique_ptr<GrootModelInternal> grootLoadModel(
    const std::string& ggufPath, bool forceCpu, const std::string& backendsDir,
    const VlaEmbodimentRequest& embodiment = {}) {
  vla_backend_selection::loadBackendsOnce(backendsDir);
  auto m = std::make_unique<GrootModelInternal>();

  ggml_backend_dev_t cpuDev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (cpuDev == nullptr) {
    throw std::runtime_error("grootLoadModel: no CPU backend available");
  }
  m->backend_cpu = ggml_backend_dev_init(cpuDev, nullptr);
  if (m->backend_cpu == nullptr) {
    throw std::runtime_error("grootLoadModel: failed to init CPU backend");
  }
  m->backend = m->backend_cpu;
  const char* cpuName = ggml_backend_name(m->backend_cpu);
  m->backend_name = cpuName != nullptr ? cpuName : "CPU";
  m->has_gpu = false;

  if (!forceCpu) {
    ggml_backend_dev_t gpu = vla_backend_selection::pickBestGpuDevice();
    if (gpu != nullptr) {
      ggml_backend_t gpuBackend = ggml_backend_dev_init(gpu, nullptr);
      if (gpuBackend != nullptr) {
        m->backend = gpuBackend;
        m->has_gpu = true;
        const char* bname = ggml_backend_name(gpuBackend);
        const char* ddesc = ggml_backend_dev_description(gpu);
        m->backend_name = bname != nullptr ? bname : "gpu";
        QLOG_IF(
            Priority::INFO,
            std::string("grootLoadModel: using GPU backend: ") +
                (bname != nullptr ? bname : "?") + " (" +
                (ddesc != nullptr ? ddesc : "?") + ")");
      }
    }
  }

  // GPU path: no_alloc=true so the GGUF loader doesn't mmap; we then allocate a
  // device backend buffer and stream the weights into it
  // (grootLoadWeightsAlloc- Copy below). Required for GPU compute — the
  // scheduler places weighted ops on the GPU and would otherwise copy every
  // weight host→device per op. CPU path: no_alloc=false so gguf_init_from_file
  // mmaps the file and tensor `data` points straight at the OS page cache (zero
  // extra heap, lazy paging — the low-footprint path the parity tests and
  // mobile builds rely on).
  struct gguf_init_params gp{};
  gp.no_alloc = m->has_gpu;
  gp.ctx = &m->ctx_w;
  m->gguf = gguf_init_from_file(ggufPath.c_str(), gp);
  if (m->gguf == nullptr) {
    throw std::runtime_error(
        "grootLoadModel: gguf_init_from_file failed for " + ggufPath);
  }
  // Kept for grootFillEmbodimentRow (setEmbodiment re-reads a row from here).
  m->gguf_path = ggufPath;

  const std::string arch = ggufGetStrOr(m->gguf, "general.architecture", "");
  if (arch != "groot") {
    throw std::runtime_error(
        "grootLoadModel: expected general.architecture=groot, got '" + arch +
        "'");
  }

  m->text_num_layers = ggufGetU32Or(m->gguf, "groot.text.num_layers", 16);
  m->text_hidden_size = ggufGetU32Or(m->gguf, "groot.text.hidden_size", 2048);
  m->text_num_heads = ggufGetU32Or(m->gguf, "groot.text.num_heads", 16);
  m->text_num_kv_heads = ggufGetU32Or(m->gguf, "groot.text.num_kv_heads", 8);
  m->text_head_dim = ggufGetU32Or(m->gguf, "groot.text.head_dim", 128);
  m->text_ffn_length = ggufGetU32Or(m->gguf, "groot.text.ffn_length", 6144);
  m->text_vocab_size = ggufGetU32Or(m->gguf, "groot.text.vocab_size", 151936);
  // Default 151655 keeps GGUFs converted before groot.image_token_id was added
  // (the metadata key is new; older merged files predate it) working unchanged.
  m->image_token_id = ggufGetU32Or(m->gguf, "groot.image_token_id", 151655);
  m->text_rope_freq_base =
      ggufGetF32Or(m->gguf, "groot.text.rope_freq_base", 5000000.0f);
  m->text_rms_norm_eps =
      ggufGetF32Or(m->gguf, "groot.text.rms_norm_eps", 1e-6f);

  m->vision_depth = ggufGetU32Or(m->gguf, "groot.vision.depth", 24);
  m->vision_hidden_size =
      ggufGetU32Or(m->gguf, "groot.vision.hidden_size", 1024);
  m->vision_num_heads = ggufGetU32Or(m->gguf, "groot.vision.num_heads", 16);
  m->vision_patch_size = ggufGetU32Or(m->gguf, "groot.vision.patch_size", 16);
  m->vision_spatial_merge_size =
      ggufGetU32Or(m->gguf, "groot.vision.spatial_merge_size", 2);
  m->vision_temporal_patch_size =
      ggufGetU32Or(m->gguf, "groot.vision.temporal_patch_size", 2);
  m->vision_num_position_embeddings =
      ggufGetU32Or(m->gguf, "groot.vision.num_position_embeddings", 2304);
  m->vision_out_hidden_size =
      ggufGetU32Or(m->gguf, "groot.vision.out_hidden_size", 2048);
  m->vision_image_size = ggufGetU32Or(m->gguf, "groot.vision.image_size", 256);
  m->vision_deepstack_indexes =
      ggufGetI32ArrOr(m->gguf, "groot.vision.deepstack_indexes", {5, 11, 17});

  m->hidden_size = ggufGetU32Or(m->gguf, "groot.hidden_size", 1024);
  m->input_embedding_dim =
      ggufGetU32Or(m->gguf, "groot.input_embedding_dim", 1536);
  m->backbone_embedding_dim =
      ggufGetU32Or(m->gguf, "groot.backbone_embedding_dim", 2048);
  m->max_state_dim = ggufGetU32Or(m->gguf, "groot.max_state_dim", 132);
  m->max_action_dim = ggufGetU32Or(m->gguf, "groot.max_action_dim", 132);
  m->num_cameras = ggufGetU32Or(m->gguf, "groot.num_cameras", 2);
  // num_cameras is rewritten per selected embodiment (here and in
  // setEmbodiment); keep the file's own value as the resolver's fallback.
  m->gguf_default_num_cameras = m->num_cameras;
  m->action_horizon = ggufGetU32Or(m->gguf, "groot.action_horizon", 40);
  m->num_inference_timesteps =
      ggufGetU32Or(m->gguf, "groot.num_inference_timesteps", 4);
  m->timestep_proj_channels =
      ggufGetU32Or(m->gguf, "groot.timestep_proj_channels", 256);

  m->dit_num_layers = ggufGetU32Or(m->gguf, "groot.dit.num_layers", 32);
  m->dit_num_heads = ggufGetU32Or(m->gguf, "groot.dit.num_heads", 32);
  m->dit_head_dim = ggufGetU32Or(m->gguf, "groot.dit.head_dim", 48);
  m->dit_ffn_inner = ggufGetU32Or(m->gguf, "groot.dit.ffn_inner", 6144);
  m->dit_output_dim = ggufGetU32Or(m->gguf, "groot.dit.output_dim", 1024);
  m->dit_attend_text_every_n_blocks =
      ggufGetU32Or(m->gguf, "groot.dit.attend_text_every_n_blocks", 2);
  m->dit_num_timestep_buckets =
      ggufGetU32Or(m->gguf, "groot.dit.num_timestep_buckets", 1000);

  m->vlfusion_num_layers =
      ggufGetU32Or(m->gguf, "groot.vlfusion.num_layers", 4);
  m->vlfusion_num_heads = ggufGetU32Or(m->gguf, "groot.vlfusion.num_heads", 32);
  m->vlfusion_head_dim = ggufGetU32Or(m->gguf, "groot.vlfusion.head_dim", 64);
  m->vlfusion_ffn_inner =
      ggufGetU32Or(m->gguf, "groot.vlfusion.ffn_inner", 8192);

  m->embodiment_tag = ggufGetStrOr(m->gguf, "groot.embodiment_tag", "");
  m->embodiment_cat_id =
      static_cast<int>(ggufGetU32Or(m->gguf, "groot.embodiment_cat_id", 0));

  // Sanity-check hparams — reject zeros (division/scaling UB) and
  // unreasonable upper bounds (OOM / integer overflow from crafted GGUFs).
  if (m->text_num_layers == 0 || m->text_num_layers > 512 ||
      m->vision_depth == 0 || m->vision_depth > 512 || m->dit_num_layers == 0 ||
      m->dit_num_layers > 512 || m->vlfusion_num_layers == 0 ||
      m->vlfusion_num_layers > 512 || m->action_horizon == 0 ||
      m->action_horizon > 1024 || m->max_state_dim == 0 ||
      m->max_state_dim > 4096 || m->max_action_dim == 0 ||
      m->max_action_dim > 4096 || m->text_hidden_size == 0 ||
      m->text_num_heads == 0 || m->text_num_kv_heads == 0 ||
      m->text_head_dim == 0 || m->text_vocab_size == 0 ||
      m->text_vocab_size > 1048576 || m->vision_hidden_size == 0 ||
      m->vision_num_heads == 0 || m->vision_patch_size == 0 ||
      m->vision_patch_size > 1024 || m->vision_image_size == 0 ||
      m->vision_image_size > 8192 ||
      m->vision_image_size % m->vision_patch_size != 0 ||
      m->vision_temporal_patch_size == 0 ||
      m->vision_temporal_patch_size > 64 || m->vision_spatial_merge_size == 0 ||
      m->hidden_size == 0 || m->input_embedding_dim == 0 ||
      m->backbone_embedding_dim == 0 || m->dit_num_heads == 0 ||
      m->dit_head_dim == 0 || m->vlfusion_num_heads == 0 ||
      m->vlfusion_head_dim == 0 || m->num_inference_timesteps == 0 ||
      m->num_inference_timesteps > 1024 ||
      // timestep_proj_channels feeds grootComputeTimestepProj, which divides
      // by (channels/2 - 1) and fills a [cos | sin] split — require it even
      // and >= 4 so half >= 2 (no div-by-zero, no degenerate 1-elem block).
      m->timestep_proj_channels < 4 || m->timestep_proj_channels % 2 != 0 ||
      m->timestep_proj_channels > 65536 ||
      // Euler bucket = floor(step * buckets / nSteps); a zero bucket count
      // collapses every step to bucket 0 (silent garbage), so reject it.
      m->dit_num_timestep_buckets == 0 || m->vision_deepstack_indexes.empty() ||
      m->dit_attend_text_every_n_blocks == 0 ||
      m->text_hidden_size % m->text_num_heads != 0 ||
      m->vision_hidden_size % m->vision_num_heads != 0 ||
      m->dit_num_heads * m->dit_head_dim != m->input_embedding_dim ||
      m->vlfusion_num_heads * m->vlfusion_head_dim !=
          m->backbone_embedding_dim) {
    throw std::runtime_error(
        "grootLoadModel: one or more GGUF hparams are out of expected range "
        "or inconsistent");
  }
  if (m->embodiment_tag.empty() || m->embodiment_cat_id < 0) {
    throw std::runtime_error(
        "grootLoadModel: missing or invalid groot.embodiment_tag/"
        "groot.embodiment_cat_id — this GGUF wasn't produced by "
        "convert_groot_dit_to_gguf.py");
  }

  // ── Multi-embodiment table + load-time selection ─────────────────────────
  // Multi GGUFs carry a tag -> cat_id map and a stored-row table; v1 GGUFs
  // carry neither (empty vectors) and fall back to the single baked embodiment.
  m->embodiment_tags = ggufGetStrArrOr(m->gguf, "groot.embodiment.tags", {});
  m->embodiment_cat_ids =
      ggufGetI32ArrOr(m->gguf, "groot.embodiment.cat_ids", {});
  m->embodiment_stored_cat_ids =
      ggufGetI32ArrOr(m->gguf, "groot.embodiment.stored_cat_ids", {});
  m->embodiment_stored_num_cameras =
      ggufGetI32ArrOr(m->gguf, "groot.embodiment.stored_num_cameras", {});
  // groot.embodiment.count is redundant with the table's length — the row count
  // is always derived from stored_cat_ids, never from this key. Cross-check it
  // anyway so a file whose two records disagree is a named load error rather
  // than a file that loads while advertising a row count it doesn't have.
  if (!m->embodiment_stored_cat_ids.empty()) {
    const size_t nRows = m->embodiment_stored_cat_ids.size();
    // Defaulting to nRows makes an absent key a no-op rather than a mismatch.
    grootCheckEmbodimentCount(
        static_cast<size_t>(ggufGetU32Or(
            m->gguf, "groot.embodiment.count", static_cast<uint32_t>(nRows))),
        nRows);
  }
  // Pick the wanted embodiment: an explicit tag/cat_id wins, else the GGUF
  // default, else the single baked tag (v1). Resolution + all error paths live
  // in the pure grootResolveEmbodiment (unit-tested in
  // test_groot_embodiment_resolve.cpp).
  const GrootEmbodimentSelection sel = grootResolveForModel(*m, embodiment);
  m->selected_embodiment_tag = sel.tag;
  m->selected_cat_id = sel.cat_id;
  m->selected_row = sel.row;
  m->num_cameras = sel.num_cameras;
  // Log the resolved selection so a '' (GGUF-default) load is observable — the
  // caller cannot otherwise tell which embodiment the default picked.
  QLOG_IF(
      Priority::INFO,
      "grootLoadModel: embodiment '" + m->selected_embodiment_tag +
          "' (cat_id " + std::to_string(m->selected_cat_id) + ", " +
          (m->selected_row < 0
               ? "single-embodiment GGUF"
               : "stored row " + std::to_string(m->selected_row)) +
          ", num_cameras " + std::to_string(m->num_cameras) + ")");

  // Reject a table/tensor rank disagreement now that the row is resolved,
  // before the GPU upload below stages rows off the back of those same extents
  // and long before mustGet requires the rest of the model to exist.
  grootCheckEmbodimentTensorRankEarly(*m);

  // GPU path: allocate a device buffer and stream the weights into it. Runs
  // BEFORE the tensor-pointer population below so a failed upload can reopen
  // ctx_w on CPU without leaving any m->vision/text/dit pointers dangling into
  // a freed context (mirrors pi05's ordering + fallback).
  if (m->has_gpu) {
    ggml_backend_buffer_type_t buft =
        ggml_backend_get_default_buffer_type(m->backend);
    const size_t dataOffset = gguf_get_data_offset(m->gguf);
    const int64_t nTensorsInGguf = gguf_get_n_tensors(m->gguf);
    if (!grootLoadWeightsAllocCopy(
            *m, ggufPath.c_str(), m->gguf, buft, dataOffset, nTensorsInGguf)) {
      QLOG_IF(
          Priority::WARNING,
          "grootLoadModel: GPU weight alloc failed — falling back to CPU");
      for (ggml_backend_buffer_t buf : m->bufs_w) {
        if (buf != nullptr) {
          ggml_backend_buffer_free(buf);
        }
      }
      m->bufs_w.clear();
      ggml_backend_free(m->backend);
      m->backend = m->backend_cpu;
      m->has_gpu = false;
      const char* cpuName = ggml_backend_name(m->backend_cpu);
      m->backend_name = cpuName != nullptr ? cpuName : "CPU";
      // Drop the embodiment-row staging bookkeeping before it outlives its
      // purpose: those tensors live in the ctx_w freed just below, and the CPU
      // path reads the selected row from the mmap instead. Reachable with the
      // placeholder block still allocated, since an alloc failure returns
      // before the loader gets to release it.
      m->emb_host_tensors.clear();
      std::vector<uint8_t>().swap(m->emb_host_bytes);
      // Reopen the GGUF with no_alloc=false so tensor data is mmapped
      // host-side.
      gguf_free(m->gguf);
      ggml_free(m->ctx_w);
      m->ctx_w = nullptr;
      m->gguf = nullptr;
      struct gguf_init_params gp2{};
      gp2.no_alloc = false;
      gp2.ctx = &m->ctx_w;
      m->gguf = gguf_init_from_file(ggufPath.c_str(), gp2);
      if (m->gguf == nullptr) {
        throw std::runtime_error(
            "grootLoadModel: gguf re-open for CPU fallback failed");
      }
    }
  }

  // GPU path: infer()'s vision phase reshapes the patch-embed conv weights and
  // bilinear-interpolates the position-embed table ON THE HOST at build time.
  // Those three weights now live in device memory (unreadable host-side), so
  // keep host copies for the precompute. They're consumed host-side only (the
  // graph inputs are the derived wlin/pe leaves), so the device copies go
  // unused — a few MB of harmless VRAM. On the CPU path the ctx_w tensors are
  // already host-accessible, so this is skipped.
  if (m->has_gpu) {
    const size_t hostVisMem = size_t(32) * 1024u * 1024u;
    struct ggml_init_params vip{hostVisMem, nullptr, /*no_alloc=*/false};
    m->ctx_host_vis = ggml_init(vip);
    const size_t dataOffset = gguf_get_data_offset(m->gguf);
    if (m->ctx_host_vis != nullptr) {
      m->host_patch_embd_w = grootHostCopyTensor(
          m->ctx_host_vis,
          ggufPath.c_str(),
          m->gguf,
          m->ctx_w,
          dataOffset,
          "v.patch_embd.weight");
      m->host_patch_embd_w1 = grootHostCopyTensor(
          m->ctx_host_vis,
          ggufPath.c_str(),
          m->gguf,
          m->ctx_w,
          dataOffset,
          "v.patch_embd.weight.1");
      m->host_position_embd = grootHostCopyTensor(
          m->ctx_host_vis,
          ggufPath.c_str(),
          m->gguf,
          m->ctx_w,
          dataOffset,
          "v.position_embd.weight");
    }
    if (m->host_patch_embd_w == nullptr || m->host_patch_embd_w1 == nullptr ||
        m->host_position_embd == nullptr) {
      throw std::runtime_error(
          "grootLoadModel: failed to stage host copies of vision weights for "
          "the GPU compute path");
    }
  }

  auto mustGet = [&](const std::string& name) -> struct ggml_tensor* {
    struct ggml_tensor* t = ggml_get_tensor(m->ctx_w, name.c_str());
    if (t == nullptr) {
      throw std::runtime_error(
          "grootLoadModel: tensor missing from GGUF: " + name);
    }
    return t;
  };

  // ── Vision tower (fabric tensor naming: v.*) ──────────────────────────
  m->vision.patch_embd_w = mustGet("v.patch_embd.weight");
  m->vision.patch_embd_w1 = mustGet("v.patch_embd.weight.1");
  m->vision.patch_embd_b = mustGet("v.patch_embd.bias");
  m->vision.position_embd = mustGet("v.position_embd.weight");
  m->vision.blocks.resize(m->vision_depth);
  for (int i = 0; i < m->vision_depth; ++i) {
    const std::string b = "v.blk." + std::to_string(i);
    auto& bw = m->vision.blocks[i];
    bw.ln1_w = mustGet(b + ".ln1.weight");
    bw.ln1_b = mustGet(b + ".ln1.bias");
    bw.attn_qkv_w = mustGet(b + ".attn_qkv.weight");
    bw.attn_qkv_b = mustGet(b + ".attn_qkv.bias");
    bw.attn_out_w = mustGet(b + ".attn_out.weight");
    bw.attn_out_b = mustGet(b + ".attn_out.bias");
    bw.ln2_w = mustGet(b + ".ln2.weight");
    bw.ln2_b = mustGet(b + ".ln2.bias");
    bw.ffn_up_w = mustGet(b + ".ffn_up.weight");
    bw.ffn_up_b = mustGet(b + ".ffn_up.bias");
    bw.ffn_down_w = mustGet(b + ".ffn_down.weight");
    bw.ffn_down_b = mustGet(b + ".ffn_down.bias");
  }
  m->vision.deepstack_mergers.resize(m->vision_deepstack_indexes.size());
  for (size_t i = 0; i < m->vision_deepstack_indexes.size(); ++i) {
    const std::string b =
        "v.deepstack." + std::to_string(m->vision_deepstack_indexes[i]);
    auto& dw = m->vision.deepstack_mergers[i];
    dw.norm_w = mustGet(b + ".norm.weight");
    dw.norm_b = mustGet(b + ".norm.bias");
    dw.fc1_w = mustGet(b + ".fc1.weight");
    dw.fc1_b = mustGet(b + ".fc1.bias");
    dw.fc2_w = mustGet(b + ".fc2.weight");
    dw.fc2_b = mustGet(b + ".fc2.bias");
  }
  m->vision.post_ln_w = mustGet("v.post_ln.weight");
  m->vision.post_ln_b = mustGet("v.post_ln.bias");
  m->vision.mm_0_w = mustGet("mm.0.weight");
  m->vision.mm_0_b = mustGet("mm.0.bias");
  m->vision.mm_2_w = mustGet("mm.2.weight");
  m->vision.mm_2_b = mustGet("mm.2.bias");

  // ── Text decoder (fabric tensor naming: blk.*, token_embd, output_norm) ─
  m->text.token_embd_w = mustGet("token_embd.weight");
  m->text.output_norm_w = mustGet("output_norm.weight");
  m->text.blocks.resize(m->text_num_layers);
  for (int i = 0; i < m->text_num_layers; ++i) {
    const std::string b = "blk." + std::to_string(i);
    auto& bw = m->text.blocks[i];
    bw.attn_norm_w = mustGet(b + ".attn_norm.weight");
    bw.attn_q_w = mustGet(b + ".attn_q.weight");
    bw.attn_k_w = mustGet(b + ".attn_k.weight");
    bw.attn_v_w = mustGet(b + ".attn_v.weight");
    bw.attn_output_w = mustGet(b + ".attn_output.weight");
    bw.attn_q_norm_w = mustGet(b + ".attn_q_norm.weight");
    bw.attn_k_norm_w = mustGet(b + ".attn_k_norm.weight");
    bw.ffn_norm_w = mustGet(b + ".ffn_norm.weight");
    bw.ffn_gate_w = mustGet(b + ".ffn_gate.weight");
    bw.ffn_up_w = mustGet(b + ".ffn_up.weight");
    bw.ffn_down_w = mustGet(b + ".ffn_down.weight");
  }

  // ── VL fusion ─────────────────────────────────────────────────────────
  m->vlfusion.vlln_w = mustGet("vlfusion.vlln.weight");
  m->vlfusion.vlln_b = mustGet("vlfusion.vlln.bias");
  m->vlfusion.blocks.resize(m->vlfusion_num_layers);
  for (int i = 0; i < m->vlfusion_num_layers; ++i) {
    const std::string b = "vlfusion.blk." + std::to_string(i);
    auto& bw = m->vlfusion.blocks[i];
    bw.norm1_w = mustGet(b + ".norm1.weight");
    bw.norm1_b = mustGet(b + ".norm1.bias");
    bw.norm3_w = mustGet(b + ".norm3.weight");
    bw.norm3_b = mustGet(b + ".norm3.bias");
    bw.attn_q_w = mustGet(b + ".attn_q.weight");
    bw.attn_q_b = mustGet(b + ".attn_q.bias");
    bw.attn_k_w = mustGet(b + ".attn_k.weight");
    bw.attn_k_b = mustGet(b + ".attn_k.bias");
    bw.attn_v_w = mustGet(b + ".attn_v.weight");
    bw.attn_v_b = mustGet(b + ".attn_v.bias");
    bw.attn_out_w = mustGet(b + ".attn_out.weight");
    bw.attn_out_b = mustGet(b + ".attn_out.bias");
    bw.ffn_in_w = mustGet(b + ".ffn_in.weight");
    bw.ffn_in_b = mustGet(b + ".ffn_in.bias");
    bw.ffn_out_w = mustGet(b + ".ffn_out.weight");
    bw.ffn_out_b = mustGet(b + ".ffn_out.bias");
  }

  // ── DiT ───────────────────────────────────────────────────────────────
  m->dit.timestep_embedder_l1_w =
      mustGet("dit.timestep_embedder.linear_1.weight");
  m->dit.timestep_embedder_l1_b =
      mustGet("dit.timestep_embedder.linear_1.bias");
  m->dit.timestep_embedder_l2_w =
      mustGet("dit.timestep_embedder.linear_2.weight");
  m->dit.timestep_embedder_l2_b =
      mustGet("dit.timestep_embedder.linear_2.bias");
  m->dit.blocks.resize(m->dit_num_layers);
  for (int i = 0; i < m->dit_num_layers; ++i) {
    const std::string b = "dit.blk." + std::to_string(i);
    auto& bw = m->dit.blocks[i];
    bw.norm1_linear_w = mustGet(b + ".norm1_linear.weight");
    bw.norm1_linear_b = mustGet(b + ".norm1_linear.bias");
    bw.attn_q_w = mustGet(b + ".attn_q.weight");
    bw.attn_q_b = mustGet(b + ".attn_q.bias");
    bw.attn_k_w = mustGet(b + ".attn_k.weight");
    bw.attn_k_b = mustGet(b + ".attn_k.bias");
    bw.attn_v_w = mustGet(b + ".attn_v.weight");
    bw.attn_v_b = mustGet(b + ".attn_v.bias");
    bw.attn_out_w = mustGet(b + ".attn_out.weight");
    bw.attn_out_b = mustGet(b + ".attn_out.bias");
    bw.ffn_in_w = mustGet(b + ".ffn_in.weight");
    bw.ffn_in_b = mustGet(b + ".ffn_in.bias");
    bw.ffn_out_w = mustGet(b + ".ffn_out.weight");
    bw.ffn_out_b = mustGet(b + ".ffn_out.bias");
  }
  m->dit.proj_out_1_w = mustGet("dit.proj_out_1.weight");
  m->dit.proj_out_1_b = mustGet("dit.proj_out_1.bias");
  m->dit.proj_out_2_w = mustGet("dit.proj_out_2.weight");
  m->dit.proj_out_2_b = mustGet("dit.proj_out_2.bias");
  m->dit.position_embedding_w = mustGet("dit.position_embedding.weight");

  // ── Embodiment-conditioned encode/decode ─────────────────────────────
  auto getLinear = [&](const std::string& prefix) -> GrootLinearWeights {
    return {mustGet(prefix + ".weight"), mustGet(prefix + ".bias")};
  };
  m->embodiment.state_encoder_layer1 =
      getLinear("embodiment.state_encoder.layer1");
  m->embodiment.state_encoder_layer2 =
      getLinear("embodiment.state_encoder.layer2");
  m->embodiment.action_encoder_w1 = getLinear("embodiment.action_encoder.w1");
  m->embodiment.action_encoder_w2 = getLinear("embodiment.action_encoder.w2");
  m->embodiment.action_encoder_w3 = getLinear("embodiment.action_encoder.w3");
  m->embodiment.action_decoder_layer1 =
      getLinear("embodiment.action_decoder.layer1");
  m->embodiment.action_decoder_layer2 =
      getLinear("embodiment.action_decoder.layer2");

  // Multi-embodiment GGUFs store these with the row dim kept; slice the
  // load-time-selected row down to plain 2-D/1-D weights before anything below
  // consumes them. No-op on v1 GGUFs (already 2-D).
  grootSliceEmbodiment(*m, m->selected_row);

  // Drop the record of the GPU-path staged rank-3 tensors. grootLoadWeights-
  // AllocCopy already nulled their data and freed the placeholder block once
  // the alloc had run, so this only releases the bookkeeping; the idempotent
  // null below also covers the CPU path, where staging never ran. Those rank-3
  // tensors are orphaned from here on — m->embodiment.* now point at the sliced
  // ctx_emb tensors — so a null deref beats a read of the wrong bytes if
  // anything ever walks ctx_w again.
  for (struct ggml_tensor* t : m->emb_host_tensors) {
    if (t != nullptr) {
      t->data = nullptr;
    }
  }
  m->emb_host_tensors.clear();
  std::vector<uint8_t>().swap(m->emb_host_bytes);

  // Pre-transpose the CategorySpecificLinear weights (best-effort; falls back
  // to the runtime-transpose path if the shapes/types are unexpected).
  grootMaterializeTransposedWeights(*m);

  return m;
}

// ── M4.1: VL fusion ─────────────────────────────────────────────────────
// One diffusers BasicTransformerBlock, self-attention only (no cross-attn,
// no AdaLN): x + attn(norm1(x)), then x + ffn(norm3(x)). Attention is full
// bidirectional MHA with no mask, faithful to the reference: its
// vl_self_attention (SelfAttentionTransformer, gr00t_n1d7.py) also runs
// unmasked over the whole VL sequence. The language mask is applied later,
// in the DiT cross-attention.
static struct ggml_tensor* grootBuildVlfusionBlock(
    struct ggml_context* ctx, struct ggml_tensor* x,
    const GrootVlfusionBlockWeights& w, int nTokens, int dim, int nHeads,
    int headDim, float eps) {
  struct ggml_tensor* residual = x;
  struct ggml_tensor* h = grootLayerNorm(ctx, x, w.norm1_w, w.norm1_b, eps);

  struct ggml_tensor* q = grootLinear(ctx, h, w.attn_q_w, w.attn_q_b);
  struct ggml_tensor* k = grootLinear(ctx, h, w.attn_k_w, w.attn_k_b);
  struct ggml_tensor* v = grootLinear(ctx, h, w.attn_v_w, w.attn_v_b);

  // (dim, nTokens) → (head_dim, n_heads, nTokens, 1) → (head_dim, nTokens,
  // n_heads, 1) so flash-attn sees each head as an independent matmul.
  q = ggml_reshape_4d(ctx, q, headDim, nHeads, nTokens, 1);
  k = ggml_reshape_4d(ctx, k, headDim, nHeads, nTokens, 1);
  v = ggml_reshape_4d(ctx, v, headDim, nHeads, nTokens, 1);
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

  // Full (non-causal) MHA — mask null. F16 K/V, F32 accumulation. Same FA
  // portability rationale as pi05's SigLIP block (desktop-class target).
  struct ggml_tensor* kf16 = ggml_cast(ctx, k, GGML_TYPE_F16);
  struct ggml_tensor* vf16 = ggml_cast(ctx, v, GGML_TYPE_F16);
  struct ggml_tensor* attnOut = ggml_flash_attn_ext(
      ctx,
      q,
      kf16,
      vf16,
      /*mask=*/nullptr,
      1.0f / std::sqrt(static_cast<float>(headDim)),
      /*max_bias=*/0.0f,
      /*logit_softcap=*/0.0f);
  ggml_flash_attn_ext_set_prec(attnOut, GGML_PREC_F32);
  attnOut = ggml_reshape_2d(ctx, attnOut, dim, nTokens);

  struct ggml_tensor* proj =
      grootLinear(ctx, attnOut, w.attn_out_w, w.attn_out_b);
  h = ggml_add(ctx, proj, residual);

  residual = h;
  h = grootLayerNorm(ctx, h, w.norm3_w, w.norm3_b, eps);
  h = grootLinear(ctx, h, w.ffn_in_w, w.ffn_in_b);
  // diffusers GELU(approximate="tanh"); ggml_gelu is the tanh approximation.
  h = ggml_gelu(ctx, h);
  h = grootLinear(ctx, h, w.ffn_out_w, w.ffn_out_b);
  return ggml_add(ctx, h, residual);
}

GrootVlfusionOutputs grootBuildVlfusionGraph(
    struct ggml_context* ctx, struct ggml_tensor* backboneFeatures,
    const GrootVlfusionWeights& w, int nTokens, int dim, int nHeads,
    int headDim, float layerNormEps) {
  GrootVlfusionOutputs out{nullptr, nullptr};
  if (ctx == nullptr || backboneFeatures == nullptr || w.vlln_w == nullptr ||
      w.vlln_b == nullptr || w.blocks.empty()) {
    return out;
  }
  if (nHeads <= 0 || dim <= 0 || headDim <= 0 || nHeads * headDim != dim) {
    return out;
  }

  struct ggml_tensor* vlln =
      grootLayerNorm(ctx, backboneFeatures, w.vlln_w, w.vlln_b, layerNormEps);
  out.vlln_out = vlln;

  struct ggml_tensor* x = vlln;
  for (const auto& bw : w.blocks) {
    x = grootBuildVlfusionBlock(
        ctx, x, bw, nTokens, dim, nHeads, headDim, layerNormEps);
  }
  out.fusion_out = x;
  return out;
}

// ── M4.2: timestep encoder + embodiment MLPs ────────────────────────────

// diffusers get_timestep_embedding, Timesteps(256, flip_sin_to_cos=True,
// downscale_freq_shift=1, max_period=10000). Layout: [cos block | sin block].
void grootComputeTimestepProj(float t, int channels, float* out) {
  const int half = channels / 2;
  const double logMax = std::log(10000.0);
  for (int i = 0; i < half; ++i) {
    // downscale_freq_shift=1 → denominator (half - 1).
    const double exponent =
        -logMax * static_cast<double>(i) / static_cast<double>(half - 1);
    const double freq = std::exp(exponent);
    const double angle = static_cast<double>(t) * freq;
    out[i] = static_cast<float>(std::cos(angle));        // flip: cos first
    out[half + i] = static_cast<float>(std::sin(angle)); // then sin
  }
}

// SinusoidalPositionalEncoding (embodiment_conditioned_mlp.py). Layout:
// [sin block | cos block], freq denominator is half_dim (not half_dim-1).
void grootComputeActionTauEnc(float t, int dim, float* out) {
  const int half = dim / 2;
  const double logMax = std::log(10000.0);
  for (int i = 0; i < half; ++i) {
    const double exponent =
        -static_cast<double>(i) * (logMax / static_cast<double>(half));
    const double freq = std::exp(exponent);
    const double angle = static_cast<double>(t) * freq;
    out[i] = static_cast<float>(std::sin(angle));        // sin first
    out[half + i] = static_cast<float>(std::cos(angle)); // then cos
  }
}

struct ggml_tensor* grootBuildTimestepMlpGraph(
    struct ggml_context* ctx, struct ggml_tensor* proj, struct ggml_tensor* l1W,
    struct ggml_tensor* l1B, struct ggml_tensor* l2W, struct ggml_tensor* l2B) {
  if (ctx == nullptr || proj == nullptr || l1W == nullptr || l2W == nullptr) {
    return nullptr;
  }
  struct ggml_tensor* h = grootLinear(ctx, proj, l1W, l1B);
  h = ggml_silu(ctx, h);
  return grootLinear(ctx, h, l2W, l2B);
}

struct ggml_tensor* grootBuildCategoryMlpGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    const GrootLinearWeights& layer1, const GrootLinearWeights& layer2,
    bool weightsPreTransposed) {
  if (ctx == nullptr || x == nullptr || layer1.weight == nullptr ||
      layer2.weight == nullptr) {
    return nullptr;
  }
  auto* lin = weightsPreTransposed ? grootLinear : grootLinearXW;
  struct ggml_tensor* h = lin(ctx, x, layer1.weight, layer1.bias);
  h = ggml_relu(ctx, h);
  return lin(ctx, h, layer2.weight, layer2.bias);
}

struct ggml_tensor* grootBuildActionEncoderGraph(
    struct ggml_context* ctx, struct ggml_tensor* actions,
    struct ggml_tensor* tauEnc, const GrootLinearWeights& w1,
    const GrootLinearWeights& w2, const GrootLinearWeights& w3, int hidden,
    int nTokens, bool weightsPreTransposed) {
  if (ctx == nullptr || actions == nullptr || tauEnc == nullptr ||
      w1.weight == nullptr || w2.weight == nullptr || w3.weight == nullptr) {
    return nullptr;
  }
  (void)nTokens;
  auto* lin = weightsPreTransposed ? grootLinear : grootLinearXW;
  // a = W1(actions) → [hidden, nTokens].
  struct ggml_tensor* a = lin(ctx, actions, w1.weight, w1.bias);
  // Broadcast the single tau vector across all action tokens, then concat on
  // the feature axis: torch.cat([a_emb, tau_emb], dim=-1) → ggml dim0.
  struct ggml_tensor* tau2 = ggml_repeat(ctx, tauEnc, a);
  struct ggml_tensor* x = ggml_concat(ctx, a, tau2, /*dim=*/0);
  x = lin(ctx, x, w2.weight, w2.bias);
  x = ggml_silu(ctx, x); // swish(x) = x·sigmoid(x) = SiLU
  x = lin(ctx, x, w3.weight, w3.bias);
  (void)hidden;
  return x;
}

// ── M4.3: DiT (AlternateVLDiT) ───────────────────────────────────────────

namespace {

// AdaLayerNorm modulation: nh = layernorm_noaffine(x) * (1 + scale) + shift,
// where [a, b] = linear(silu(temb)).chunk(2). `scaleFirst` picks the chunk
// order: the per-block AdaLayerNorm uses (scale, shift) (dit.py:95) but the
// output head uses (shift, scale) (dit.py:331) — opposite halves.
static struct ggml_tensor* grootAdaModulate(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* temb,
    struct ggml_tensor* linW, struct ggml_tensor* linB, int dim, float eps,
    bool scaleFirst) {
  struct ggml_tensor* proj = grootLinear(ctx, ggml_silu(ctx, temb), linW, linB);
  const size_t half = static_cast<size_t>(dim) * ggml_element_size(proj);
  struct ggml_tensor* scale =
      ggml_view_1d(ctx, proj, dim, scaleFirst ? 0 : half);
  struct ggml_tensor* shift =
      ggml_view_1d(ctx, proj, dim, scaleFirst ? half : 0);
  struct ggml_tensor* normed = ggml_norm(ctx, x, eps); // no affine
  // normed * (1 + scale) + shift = normed*scale + normed + shift, with the
  // (dim,) scale/shift broadcast across the T token axis.
  struct ggml_tensor* out = ggml_mul(ctx, normed, scale);
  out = ggml_add(ctx, out, normed);
  out = ggml_add(ctx, out, shift);
  return out;
}

// Scaled-dot-product attention, unfused F32, optional additive key-mask.
// nh ne=[dim, T]; kvSrc ne=[kvDim, S]; keyMask ne=[S, T] (0/−inf) or null.
static struct ggml_tensor* grootDitAttention(
    struct ggml_context* ctx, struct ggml_tensor* nh, struct ggml_tensor* kvSrc,
    struct ggml_tensor* keyMask, const GrootDitBlockWeights& w, int nHeads,
    int headDim, int dim) {
  const int64_t nQuery = nh->ne[1];
  const int64_t nKv = kvSrc->ne[1];
  struct ggml_tensor* q = grootLinear(ctx, nh, w.attn_q_w, w.attn_q_b);
  struct ggml_tensor* k = grootLinear(ctx, kvSrc, w.attn_k_w, w.attn_k_b);
  struct ggml_tensor* v = grootLinear(ctx, kvSrc, w.attn_v_w, w.attn_v_b);

  q = ggml_reshape_3d(ctx, q, headDim, nHeads, nQuery);
  k = ggml_reshape_3d(ctx, k, headDim, nHeads, nKv);
  v = ggml_reshape_3d(ctx, v, headDim, nHeads, nKv);
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3)); // [headDim, T, nHeads]
  k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3)); // [headDim, S, nHeads]
  v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3)); // [headDim, S, nHeads]

  struct ggml_tensor* kq = ggml_mul_mat(ctx, k, q); // [S, T, nHeads]
  kq = ggml_soft_max_ext(
      ctx, kq, keyMask, 1.0f / std::sqrt(static_cast<float>(headDim)), 0.0f);
  // v → [S, headDim, nHeads] so mul_mat(v, kq) sums over S → [headDim, T,
  // nHeads].
  v = ggml_cont(ctx, ggml_permute(ctx, v, 1, 0, 2, 3));
  struct ggml_tensor* kqv = ggml_mul_mat(ctx, v, kq); // [headDim, T, nHeads]
  kqv = ggml_cont(
      ctx, ggml_permute(ctx, kqv, 0, 2, 1, 3)); // [headDim, nHeads, nQuery]
  kqv = ggml_reshape_2d(ctx, kqv, dim, nQuery);
  return grootLinear(ctx, kqv, w.attn_out_w, w.attn_out_b);
}

} // namespace

struct ggml_tensor* grootBuildDitBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* temb,
    struct ggml_tensor* encoder, struct ggml_tensor* keyMask,
    const GrootDitBlockWeights& w, int nHeads, int headDim, int dim,
    int crossDim, int ffnInner, float eps) {
  if (ctx == nullptr || x == nullptr || temb == nullptr ||
      w.norm1_linear_w == nullptr || w.attn_q_w == nullptr) {
    return nullptr;
  }
  (void)crossDim;
  (void)ffnInner;
  // AdaLayerNorm (scale, shift order) → attention → residual.
  struct ggml_tensor* nh = grootAdaModulate(
      ctx,
      x,
      temb,
      w.norm1_linear_w,
      w.norm1_linear_b,
      dim,
      eps,
      /*scaleFirst=*/true);
  struct ggml_tensor* kvSrc = (encoder != nullptr) ? encoder : nh;
  struct ggml_tensor* attn =
      grootDitAttention(ctx, nh, kvSrc, keyMask, w, nHeads, headDim, dim);
  struct ggml_tensor* h = ggml_add(ctx, attn, x);

  // norm3 (plain LayerNorm, no affine) → GELU-approx FFN → residual.
  struct ggml_tensor* nh3 = ggml_norm(ctx, h, eps);
  struct ggml_tensor* ff = grootLinear(ctx, nh3, w.ffn_in_w, w.ffn_in_b);
  ff = ggml_gelu(ctx, ff);
  ff = grootLinear(ctx, ff, w.ffn_out_w, w.ffn_out_b);
  return ggml_add(ctx, ff, h);
}

struct ggml_tensor* grootBuildDitGraph(
    struct ggml_context* ctx, struct ggml_tensor* hidden,
    struct ggml_tensor* temb, struct ggml_tensor* encoder,
    struct ggml_tensor* imageKeyMask, struct ggml_tensor* textKeyMask,
    const GrootDitWeights& w, int nLayers, int nHeads, int headDim, int dim,
    int crossDim, int ffnInner, int outputDim, int attendTextEveryN, float eps,
    std::vector<struct ggml_tensor*>* outBlocks) {
  if (ctx == nullptr || hidden == nullptr || temb == nullptr ||
      encoder == nullptr || static_cast<int>(w.blocks.size()) < nLayers) {
    return nullptr;
  }
  struct ggml_tensor* h = hidden;
  for (int idx = 0; idx < nLayers; ++idx) {
    const bool selfAttn =
        (idx % 2 == 1); // AlternateVLDiT: odd blocks self-attend
    struct ggml_tensor* enc = selfAttn ? nullptr : encoder;
    struct ggml_tensor* mask = nullptr;
    if (!selfAttn) {
      // Even cross-attn blocks alternate text/image every attendTextEveryN
      // cross-attn block: idx % (2*n) == 0 → text tokens, else image tokens.
      const bool text = (idx % (2 * attendTextEveryN) == 0);
      mask = text ? textKeyMask : imageKeyMask;
    }
    h = grootBuildDitBlockGraph(
        ctx,
        h,
        temb,
        enc,
        mask,
        w.blocks[idx],
        nHeads,
        headDim,
        dim,
        crossDim,
        ffnInner,
        eps);
    if (outBlocks != nullptr) {
      outBlocks->push_back(h);
    }
  }

  // Output head: norm_out (no affine, eps 1e-6) modulated by AdaLN from
  // proj_out_1 (shift, scale order — opposite of the block AdaLayerNorm), then
  // proj_out_2 to the action-space output dim.
  struct ggml_tensor* modulated = grootAdaModulate(
      ctx,
      h,
      temb,
      w.proj_out_1_w,
      w.proj_out_1_b,
      dim,
      /*eps=*/1e-6f,
      /*scaleFirst=*/false);
  (void)outputDim;
  return grootLinear(ctx, modulated, w.proj_out_2_w, w.proj_out_2_b);
}

// ── M4.5: Qwen3-VL text decoder (backbone language side) ────────────────

namespace {

// RMSNorm over dim0 (the feature axis) with a scale weight, no bias — Qwen3
// convention. Weight promoted to F32 to combine with F32 activations.
static struct ggml_tensor* grootRmsNorm(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    float eps) {
  x = ggml_rms_norm(ctx, x, eps);
  if (weight != nullptr) {
    x = ggml_mul(ctx, x, grootToF32(ctx, weight));
  }
  return x;
}

// One Qwen3-VL decoder layer's self-attention: per-head Q/K RMSNorm → M-RoPE
// (interleaved, GGML_ROPE_TYPE_IMROPE) → GQA scaled-dot-product with a causal
// additive mask. Unfused F32 (280 tokens is tiny; F32 keeps us strictly more
// precise than the bf16 oracle). `nh` ne=[dim, T] is the pre-normed input.
static struct ggml_tensor* grootTextAttention(
    struct ggml_context* ctx, struct ggml_tensor* nh,
    struct ggml_tensor* positions, struct ggml_tensor* mask,
    const GrootTextBlockWeights& w, int nHead, int nHeadKv, int headDim,
    int nTokens, float ropeFreqBase, const int ropeSections[4], float rmsEps) {
  const int embdQ = nHead * headDim;
  const int embdKv = nHeadKv * headDim;

  struct ggml_tensor* q = ggml_mul_mat(ctx, w.attn_q_w, nh); // [embdQ, T]
  struct ggml_tensor* k = ggml_mul_mat(ctx, w.attn_k_w, nh); // [embdKv, T]
  struct ggml_tensor* v = ggml_mul_mat(ctx, w.attn_v_w, nh); // [embdKv, T]
  (void)embdQ;
  (void)embdKv;

  q = ggml_reshape_3d(ctx, q, headDim, nHead, nTokens);
  k = ggml_reshape_3d(ctx, k, headDim, nHeadKv, nTokens);
  v = ggml_reshape_3d(ctx, v, headDim, nHeadKv, nTokens);

  // Per-head RMSNorm on the head_dim axis, before RoPE (Qwen3 q/k norm).
  q = grootRmsNorm(ctx, q, w.attn_q_norm_w, rmsEps);
  k = grootRmsNorm(ctx, k, w.attn_k_norm_w, rmsEps);

  int sections[4] = {
      ropeSections[0], ropeSections[1], ropeSections[2], ropeSections[3]};
  q = ggml_rope_multi(
      ctx,
      q,
      positions,
      nullptr,
      headDim,
      sections,
      GGML_ROPE_TYPE_IMROPE,
      /*n_ctx_orig=*/32768,
      ropeFreqBase,
      /*freq_scale=*/1.0f,
      /*ext_factor=*/0.0f,
      /*attn_factor=*/1.0f,
      /*beta_fast=*/32.0f,
      /*beta_slow=*/1.0f);
  k = ggml_rope_multi(
      ctx,
      k,
      positions,
      nullptr,
      headDim,
      sections,
      GGML_ROPE_TYPE_IMROPE,
      32768,
      ropeFreqBase,
      1.0f,
      0.0f,
      1.0f,
      32.0f,
      1.0f);

  // [headDim, T, nHead] / [headDim, T, nHeadKv] — K broadcasts over the GQA
  // group (nHead / nHeadKv) inside ggml_mul_mat.
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

  struct ggml_tensor* kq = ggml_mul_mat(ctx, k, q); // [T_kv, T_q, nHead]
  kq = ggml_soft_max_ext(
      ctx, kq, mask, 1.0f / std::sqrt(static_cast<float>(headDim)), 0.0f);
  // v → [T_kv, headDim, nHeadKv] so mul_mat sums over keys → [headDim, T_q,
  // nHead].
  v = ggml_cont(ctx, ggml_permute(ctx, v, 1, 0, 2, 3));
  struct ggml_tensor* kqv = ggml_mul_mat(ctx, v, kq); // [headDim, T_q, nHead]
  kqv = ggml_cont(ctx, ggml_permute(ctx, kqv, 0, 2, 1, 3));
  kqv = ggml_reshape_2d(ctx, kqv, nHead * headDim, nTokens);
  return ggml_mul_mat(ctx, w.attn_output_w, kqv);
}

} // namespace

struct ggml_tensor* grootBuildTextDecoderGraph(
    struct ggml_context* ctx, struct ggml_tensor* inputsEmbeds,
    struct ggml_tensor* positions, struct ggml_tensor* mask,
    const std::vector<struct ggml_tensor*>& deepstack,
    const GrootTextWeights& w, int nLayers, int nTokens, int nHead, int nHeadKv,
    int headDim, int ffnLen, float ropeFreqBase, const int ropeSections[4],
    float rmsEps) {
  if (ctx == nullptr || inputsEmbeds == nullptr || positions == nullptr ||
      mask == nullptr || static_cast<int>(w.blocks.size()) < nLayers) {
    return nullptr;
  }
  (void)ffnLen;
  struct ggml_tensor* cur = inputsEmbeds;
  for (int il = 0; il < nLayers; ++il) {
    const auto& bw = w.blocks[il];
    struct ggml_tensor* inpSA = cur;

    struct ggml_tensor* nh = grootRmsNorm(ctx, cur, bw.attn_norm_w, rmsEps);
    struct ggml_tensor* attn = grootTextAttention(
        ctx,
        nh,
        positions,
        mask,
        bw,
        nHead,
        nHeadKv,
        headDim,
        nTokens,
        ropeFreqBase,
        ropeSections,
        rmsEps);
    struct ggml_tensor* ffnInp = ggml_add(ctx, attn, inpSA);

    // SwiGLU FFN: down(silu(gate(x)) * up(x)).
    struct ggml_tensor* fn = grootRmsNorm(ctx, ffnInp, bw.ffn_norm_w, rmsEps);
    struct ggml_tensor* gate = ggml_mul_mat(ctx, bw.ffn_gate_w, fn);
    struct ggml_tensor* up = ggml_mul_mat(ctx, bw.ffn_up_w, fn);
    struct ggml_tensor* act = ggml_mul(ctx, ggml_silu(ctx, gate), up);
    struct ggml_tensor* down = ggml_mul_mat(ctx, bw.ffn_down_w, act);
    cur = ggml_add(ctx, down, ffnInp);

    // Deepstack injection: add the merged visual features to the residual
    // stream after layers 0/1/2 (indices 0..deepstack.size()-1).
    if (il < static_cast<int>(deepstack.size()) && deepstack[il] != nullptr) {
      cur = ggml_add(ctx, cur, deepstack[il]);
    }
  }
  // NB: no final output_norm — backbone_features is the raw residual stream
  // (GR00T's select_layer=16 truncation output), see header note.
  return cur;
}

// ── M4.5: Qwen3-VL vision tower ─────────────────────────────────────────

// GR00T reads patch/position-embedding weights host-side and assumes raw F32 or
// F16 element storage. Quantized tensors use block layouts, so reinterpreting
// their bytes as ggml_fp16_t[] would read garbage or past the element layout; a
// malformed GGUF could also carry an unexpected type. Require contiguous
// F32/F16 before any raw data[] index so these paths fail closed instead.
static bool grootIsRawF32OrF16(const struct ggml_tensor* t) {
  return t != nullptr && ggml_is_contiguous(t) &&
         (t->type == GGML_TYPE_F32 || t->type == GGML_TYPE_F16);
}

struct ggml_tensor* grootBuildPatchEmbedLinear(
    struct ggml_context* ctx, const struct ggml_tensor* conv0,
    const struct ggml_tensor* conv1, int nEmbd, int inChannels,
    int temporalPatch, int patchSize) {
  if (ctx == nullptr || conv0 == nullptr || conv1 == nullptr ||
      temporalPatch != 2) {
    return nullptr; // v1 fixture: 2 temporal halves (conv0 = t0, conv1 = t1).
  }
  const int patch = patchSize;
  const int numCh = inChannels;
  const int inFlat = numCh * temporalPatch * patch * patch;
  const struct ggml_tensor* conv[2] = {conv0, conv1};

  // readVal below indexes each conv half up to patch·patch·numCh·nEmbd-1 using
  // dims taken from GGUF metadata (patchSize/inChannels/nEmbd). mustGet() only
  // proves the tensor exists, not that its actual shape matches that metadata —
  // a GGUF whose declared dims exceed the real tensor triggers a heap OOB read.
  // Reject the mismatch cleanly (callers treat nullptr as a load/infer
  // failure).
  const int64_t convNeed = static_cast<int64_t>(patch) * patch * numCh * nEmbd;
  if (ggml_nelements(conv0) < convNeed || ggml_nelements(conv1) < convNeed) {
    return nullptr;
  }
  // readVal below reinterprets conv data[] as raw F32/F16; reject any other
  // (e.g. quantized block) layout before the host reads.
  if (!grootIsRawF32OrF16(conv0) || !grootIsRawF32OrF16(conv1)) {
    return nullptr;
  }

  auto readVal = [](const struct ggml_tensor* t, size_t i) -> float {
    if (t->type == GGML_TYPE_F32) {
      return static_cast<const float*>(t->data)[i];
    }
    return ggml_fp16_to_fp32(static_cast<const ggml_fp16_t*>(t->data)[i]);
  };

  struct ggml_tensor* wlin =
      ggml_new_tensor_2d(ctx, GGML_TYPE_F32, inFlat, nEmbd);
  auto* wd = static_cast<float*>(wlin->data);
  // conv ne=[pw, ph, C, OC] contiguous: idx = pw + P*(ph + P*(c + C*oc)).
  // linear flat = ((c*T + t)*P + ph)*P + pw.
  for (int oc = 0; oc < nEmbd; ++oc) {
    for (int c = 0; c < numCh; ++c) {
      for (int ph = 0; ph < patch; ++ph) {
        for (int pw = 0; pw < patch; ++pw) {
          const size_t src =
              static_cast<size_t>(pw) +
              static_cast<size_t>(patch) *
                  (ph + static_cast<size_t>(patch) *
                            (c + static_cast<size_t>(numCh) * oc));
          for (int t = 0; t < temporalPatch; ++t) {
            const int flat =
                ((c * temporalPatch + t) * patch + ph) * patch + pw;
            wd[static_cast<size_t>(oc) * inFlat + flat] = readVal(conv[t], src);
          }
        }
      }
    }
  }
  return wlin;
}

namespace {

// Qwen3-VL learned position embedding (get_vision_bilinear_indices_and_weights
// + pos_embed, modeling_qwen3_vl.py). Align-corners bilinear interpolation of
// the √numPosEmbd base grid to the actual gridH×gridW, emitted directly in
// 2×2-merge sequence order via HF's `reorder`. Computed host-side from the F16
// table (exact — ggml_interpolate's antialiased bilinear does NOT match).
// Returns an F32 tensor ne=[nEmbd, gridH*gridW] for one image.
static struct ggml_tensor* grootBuildVisionPosEmbed(
    struct ggml_context* ctx, const struct ggml_tensor* table, int gridH,
    int gridW, int mergeSize, int numPosEmbd, int nEmbd) {
  const int side =
      static_cast<int>(std::lround(std::sqrt(static_cast<double>(numPosEmbd))));
  const int nOut = gridH * gridW;

  // tableVal indexes `table` up to side·side·nEmbd-1 using dims derived from
  // GGUF metadata (numPosEmbd/nEmbd), not the tensor's own ne[]. A GGUF whose
  // declared dims exceed the real position_embd tensor would read out of bounds
  // (garbage into the vision embeddings). Reject the mismatch cleanly.
  if (static_cast<int64_t>(side) * side * nEmbd > ggml_nelements(table)) {
    return nullptr;
  }
  // tableVal reinterprets table data[] as raw F32/F16; reject any other layout.
  if (!grootIsRawF32OrF16(table)) {
    return nullptr;
  }

  auto tableVal = [&](int col, int e) -> float {
    const size_t idx = static_cast<size_t>(col) * nEmbd + e;
    if (table->type == GGML_TYPE_F32) {
      return static_cast<const float*>(table->data)[idx];
    }
    return ggml_fp16_to_fp32(static_cast<const ggml_fp16_t*>(table->data)[idx]);
  };

  auto gridCoord = [](int i, int n, int s) -> double {
    // torch.linspace(0, s-1, n)
    return n > 1 ? static_cast<double>(i) * (s - 1) / (n - 1) : 0.0;
  };

  struct ggml_tensor* pe = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, nEmbd, nOut);
  auto* pd = static_cast<float*>(pe->data);

  const int m = mergeSize;
  int seq = 0;
  // HF `reorder`: iterate merge-block rows (a), cols (cc), then in-block (b,d).
  for (int a = 0; a < gridH / m; ++a) {
    for (int cc = 0; cc < gridW / m; ++cc) {
      for (int b = 0; b < m; ++b) {
        for (int d = 0; d < m; ++d) {
          const int oh = a * m + b;
          const int ow = cc * m + d;
          const double hg = gridCoord(oh, gridH, side);
          const double wg = gridCoord(ow, gridW, side);
          const int hf = static_cast<int>(hg);
          const int wf = static_cast<int>(wg);
          const int hc = std::min(hf + 1, side - 1);
          const int wc = std::min(wf + 1, side - 1);
          const double hfrac = hg - hf;
          const double wfrac = wg - wf;
          const int c0 = hf * side + wf, c1 = hf * side + wc;
          const int c2 = hc * side + wf, c3 = hc * side + wc;
          const double w0 = (1 - hfrac) * (1 - wfrac);
          const double w1 = (1 - hfrac) * wfrac;
          const double w2 = hfrac * (1 - wfrac);
          const double w3 = hfrac * wfrac;
          for (int e = 0; e < nEmbd; ++e) {
            pd[static_cast<size_t>(seq) * nEmbd + e] = static_cast<float>(
                w0 * tableVal(c0, e) + w1 * tableVal(c1, e) +
                w2 * tableVal(c2, e) + w3 * tableVal(c3, e));
          }
          ++seq;
        }
      }
    }
  }
  return pe;
}

// One Qwen3-VL vision block: LayerNorm → fused-QKV self-attention with vision
// M-RoPE and an additive (block-diagonal) mask → residual; LayerNorm → GELU FFN
// → residual. Unfused F32 attention (mirrors clip_graph::build_attn's non-flash
// path). `x` ne=[nEmbd, nPos]; returns same.
static struct ggml_tensor* grootBuildVisionBlock(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* positions, struct ggml_tensor* mask,
    const GrootVisionBlockWeights& w, int nPos, int nEmbd, int nHead,
    int headDim, float eps, float ropeFreqBase) {
  struct ggml_tensor* residual = x;
  struct ggml_tensor* cur = grootLayerNorm(ctx, x, w.ln1_w, w.ln1_b, eps);

  cur = grootLinear(ctx, cur, w.attn_qkv_w, w.attn_qkv_b); // [3*nEmbd, nPos]
  const size_t rowSize = ggml_row_size(cur->type, headDim);
  struct ggml_tensor* q =
      ggml_view_3d(ctx, cur, headDim, nHead, nPos, rowSize, cur->nb[1], 0);
  struct ggml_tensor* k = ggml_view_3d(
      ctx,
      cur,
      headDim,
      nHead,
      nPos,
      rowSize,
      cur->nb[1],
      ggml_row_size(cur->type, nEmbd));
  struct ggml_tensor* v = ggml_view_3d(
      ctx,
      cur,
      headDim,
      nHead,
      nPos,
      rowSize,
      cur->nb[1],
      ggml_row_size(cur->type, 2 * nEmbd));

  int sections[4] = {headDim / 4, headDim / 4, headDim / 4, headDim / 4};
  q = ggml_rope_multi(
      ctx,
      q,
      positions,
      nullptr,
      headDim / 2,
      sections,
      GGML_ROPE_TYPE_VISION,
      32768,
      ropeFreqBase,
      1.0f,
      0.0f,
      1.0f,
      32.0f,
      1.0f);
  k = ggml_rope_multi(
      ctx,
      k,
      positions,
      nullptr,
      headDim / 2,
      sections,
      GGML_ROPE_TYPE_VISION,
      32768,
      ropeFreqBase,
      1.0f,
      0.0f,
      1.0f,
      32.0f,
      1.0f);

  q = ggml_cont(
      ctx, ggml_permute(ctx, q, 0, 2, 1, 3)); // [headDim, nPos, nHead]
  k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  struct ggml_tensor* vt = ggml_cont(
      ctx, ggml_permute(ctx, v, 1, 2, 0, 3)); // [nPos, headDim, nHead]

  struct ggml_tensor* kq = ggml_mul_mat(ctx, k, q); // [nPos_kv, nPos_q, nHead]
  kq = ggml_soft_max_ext(
      ctx, kq, mask, 1.0f / std::sqrt(static_cast<float>(headDim)), 0.0f);
  struct ggml_tensor* kqv =
      ggml_mul_mat(ctx, vt, kq); // [headDim, nPos_q, nHead]
  kqv = ggml_permute(ctx, kqv, 0, 2, 1, 3);
  kqv = ggml_cont_2d(ctx, kqv, nEmbd, nPos);
  struct ggml_tensor* attn = grootLinear(ctx, kqv, w.attn_out_w, w.attn_out_b);
  cur = ggml_add(ctx, attn, residual);

  residual = cur;
  struct ggml_tensor* h = grootLayerNorm(ctx, cur, w.ln2_w, w.ln2_b, eps);
  h = grootLinear(ctx, h, w.ffn_up_w, w.ffn_up_b);
  h = ggml_gelu(ctx, h);
  h = grootLinear(ctx, h, w.ffn_down_w, w.ffn_down_b);
  return ggml_add(ctx, h, residual);
}

// 2×2 patch merger MLP (mm.0 → GELU → mm.2, no gate). `x` ne=[nEmbd, nPos]
// where consecutive groups of merge² patches form one output token (GR00T's
// processor already lays patches out in merge order). Returns [outHidden,
// nPos/m²].
static struct ggml_tensor* grootVisionMerge(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* fc1W,
    struct ggml_tensor* fc1B, struct ggml_tensor* fc2W,
    struct ggml_tensor* fc2B, int nEmbd, int nPos, int mergeFactor,
    struct ggml_tensor* normW, struct ggml_tensor* normB, float eps) {
  struct ggml_tensor* m =
      ggml_reshape_2d(ctx, x, nEmbd * mergeFactor, nPos / mergeFactor);
  if (normW != nullptr) {
    m = grootLayerNorm(ctx, m, normW, normB, eps);
  }
  m = grootLinear(ctx, m, fc1W, fc1B);
  // Qwen3VLVisionPatchMerger uses nn.GELU() — exact (erf) GELU, unlike the
  // vision blocks' gelu_pytorch_tanh MLP.
  m = ggml_gelu_erf(ctx, m);
  return grootLinear(ctx, m, fc2W, fc2B);
}

} // namespace

struct ggml_tensor* grootBuildVisionGraph(
    struct ggml_context* ctx, struct ggml_tensor* patchInput,
    struct ggml_tensor* patchWLin, struct ggml_tensor* patchBias,
    struct ggml_tensor* positionEmbd, struct ggml_tensor* positions,
    struct ggml_tensor* mask, const GrootVisionWeights& w, int nImages,
    int gridH, int gridW, int nEmbd, int nHead, int headDim, int mergeSize,
    int numPosEmbd, int outHidden, float eps, float ropeFreqBase,
    const std::vector<int>& deepstackIndexes,
    std::vector<struct ggml_tensor*>* outDeepstack,
    std::vector<struct ggml_tensor*>* outBlocks, struct ggml_context* hostCtx,
    struct ggml_tensor* precomputedPe) {
  if (ctx == nullptr || patchInput == nullptr || patchWLin == nullptr ||
      positionEmbd == nullptr || positions == nullptr || mask == nullptr ||
      w.blocks.empty()) {
    return nullptr;
  }
  // Host-written leaf (pos-embed table) lives in `hostCtx`; compute ops go in
  // `ctx`. Same ctx when hostCtx is null (test callers, single no_alloc=false).
  struct ggml_context* hc = hostCtx != nullptr ? hostCtx : ctx;
  (void)outHidden;
  const int nPatchesPerImg = gridH * gridW;
  const int nPos = nImages * nPatchesPerImg;
  const int mergeFactor = mergeSize * mergeSize;

  // ── Patch embed (Linear) + bias ────────────────────────────────────────
  struct ggml_tensor* inp =
      ggml_mul_mat(ctx, patchWLin, patchInput); // [nEmbd, nPos]
  inp = ggml_add(ctx, inp, grootToF32(ctx, patchBias));

  // ── Learned position embedding (Qwen3-VL align-corners bilinear, merge
  // order), computed host-side then tiled per image. `precomputedPe` (per-image
  // [nEmbd, nPatchesPerImg]) lets infer() supply the table as a graph input on
  // the GPU path — where `positionEmbd`'s data is in device memory and can't be
  // read host-side; when null (test callers) it's computed here from the table.
  struct ggml_tensor* pe =
      precomputedPe != nullptr
          ? precomputedPe
          : grootBuildVisionPosEmbed(
                hc, positionEmbd, gridH, gridW, mergeSize, numPosEmbd, nEmbd);
  struct ggml_tensor* peTiled = pe;
  for (int i = 1; i < nImages; ++i) {
    peTiled = ggml_concat(ctx, peTiled, pe, /*dim=*/1);
  }
  inp = ggml_add(ctx, inp, peTiled);

  // ── Transformer blocks + deepstack mergers ─────────────────────────────
  struct ggml_tensor* cur = inp;
  for (int il = 0; il < static_cast<int>(w.blocks.size()); ++il) {
    cur = grootBuildVisionBlock(
        ctx,
        cur,
        positions,
        mask,
        w.blocks[il],
        nPos,
        nEmbd,
        nHead,
        headDim,
        eps,
        ropeFreqBase);
    if (outBlocks != nullptr) {
      outBlocks->push_back(cur);
    }
    if (outDeepstack != nullptr) {
      for (size_t d = 0; d < deepstackIndexes.size(); ++d) {
        if (deepstackIndexes[d] == il && d < w.deepstack_mergers.size()) {
          const auto& dm = w.deepstack_mergers[d];
          outDeepstack->push_back(grootVisionMerge(
              ctx,
              cur,
              dm.fc1_w,
              dm.fc1_b,
              dm.fc2_w,
              dm.fc2_b,
              nEmbd,
              nPos,
              mergeFactor,
              dm.norm_w,
              dm.norm_b,
              eps));
        }
      }
    }
  }

  // ── post-LayerNorm → 2×2 merge projection (mm.0 → GELU → mm.2). ──────────
  cur = grootLayerNorm(ctx, cur, w.post_ln_w, w.post_ln_b, eps);
  return grootVisionMerge(
      ctx,
      cur,
      w.mm_0_w,
      w.mm_0_b,
      w.mm_2_w,
      w.mm_2_b,
      nEmbd,
      nPos,
      mergeFactor,
      /*normW=*/nullptr,
      /*normB=*/nullptr,
      eps);
}

// Test hook: run a single vision block in isolation (see
// test_groot_m4_5_vision).
struct ggml_tensor* grootBuildVisionBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* positions, struct ggml_tensor* mask,
    const GrootVisionBlockWeights& w, int nPos, int nEmbd, int nHead,
    int headDim, float eps, float ropeFreqBase) {
  return grootBuildVisionBlock(
      ctx,
      x,
      positions,
      mask,
      w,
      nPos,
      nEmbd,
      nHead,
      headDim,
      eps,
      ropeFreqBase);
}

// ── GrootModel ────────────────────────────────────────────────────────────

GrootModel::GrootModel(
    const std::string& ggufPath, bool forceCpu, const std::string& backendsDir,
    const VlaEmbodimentRequest& embodiment)
    : impl_(grootLoadModel(ggufPath, forceCpu, backendsDir, embodiment)) {
  hparams_.chunk_size = impl_->action_horizon;
  hparams_.action_dim = impl_->max_action_dim;
  hparams_.max_action_dim = impl_->max_action_dim;
  hparams_.max_state_dim = impl_->max_state_dim;
  hparams_.tokenizer_max_length = 0; // GR00T's tokenization/templating is
                                     // consumer-side, no fixed length yet
  hparams_.vision_image_size = impl_->vision_image_size;
  hparams_.num_cameras = impl_->num_cameras;
  hparams_.selected_embodiment_tag = impl_->selected_embodiment_tag;
  hparams_.selected_embodiment_cat_id = impl_->selected_cat_id;
  hparams_.state_input_mode = VlaHparamsGeneric::StateInputMode::Continuous;
  // Images arrive pre-patchified from Gr00tPolicy (see infer()'s contract),
  // not as raw pixels — the JS validator branches on this.
  hparams_.image_input_mode = VlaHparamsGeneric::ImageInputMode::Patches;
  // Exact per-camera patch-buffer length so the JS validator can reject a
  // mis-sized buffer (matches infer()'s patchesPerImg · inFlat; imgWidth is
  // pinned to vision_image_size, so the geometry is fixed). patch_size is
  // guaranteed non-zero by grootLoadModel's hparam sanity check.
  // Compute in int64 so a crafted GGUF can't overflow the product to <= 0 and
  // silently disable the JS validator's exact-length guard (which treats a
  // non-positive image_patch_elems as "unknown" and downgrades to a
  // non-empty-only check). grootLoadModel already bounds image_size/patch_size
  // and enforces image_size % patch_size == 0, so this stays well within int.
  const int64_t patchGrid =
      int64_t(impl_->vision_image_size) / impl_->vision_patch_size;
  const int64_t inFlat = int64_t(3) * impl_->vision_temporal_patch_size *
                         impl_->vision_patch_size * impl_->vision_patch_size;
  const int64_t patchElems = patchGrid * patchGrid * inFlat;
  if (patchElems <= 0 || patchElems > INT32_MAX) {
    throw std::runtime_error(
        "GrootModel: image_patch_elems out of range — corrupt vision hparams");
  }
  hparams_.image_patch_elems = static_cast<int>(patchElems);
}

GrootModel::~GrootModel() {
  // Free the cached per-phase schedulers BEFORE impl_ (and the backends they
  // reference) is destroyed. grootSchedFree is a no-op on an unused (null)
  // slot.
  if (impl_) {
    grootSchedFree(impl_->sched_vision);
    grootSchedFree(impl_->sched_tokemb);
    grootSchedFree(impl_->sched_text);
    grootSchedFree(impl_->sched_vlfusion);
    grootSchedFree(impl_->sched_dit);
  }
}

std::string GrootModel::backendName() const {
  return impl_ ? impl_->backend_name : std::string("none");
}

bool GrootModel::hasGpu() const { return impl_ && impl_->has_gpu; }

void GrootModel::setEmbodiment(const VlaEmbodimentRequest& request) {
  GrootModelInternal& m = *impl_;
  const std::lock_guard<std::mutex> embodimentGuard(m.embodiment_mutex);
  // Same resolver, same error surface as the ctor: an unknown tag/cat_id, one
  // outside the ship set, or an embodiment with no known camera count and no
  // override throws and leaves the currently loaded row untouched (nothing has
  // been written yet).
  const GrootEmbodimentSelection sel = grootResolveForModel(m, request);
  if (m.emb_slices.empty()) {
    // No staged slices means the tensors were never rank-3, i.e. a v1 GGUF with
    // one baked embodiment: there is no row to swap in. Tested WITHOUT also
    // requiring sel.row >= 0, because on a v1 GGUF the resolver returns row -1,
    // so a row-conditioned check let setEmbodiment(bakedTag) "succeed" as a
    // silent no-op — and a numCameras override then rewrote
    // hparams_.num_cameras on a model that cannot honour it. Every doc site
    // says a single-embodiment model is rejected; this is what makes that true.
    throw std::runtime_error(
        "GrootModel::setEmbodiment: this GGUF stores a single embodiment row");
  }
  if (sel.row != m.selected_row) {
    // All-or-nothing, and that hinges on every allocation AND every check
    // happening BEFORE the first write: the transpose scratch is sized and
    // validated here, grootFillEmbodimentRow reads all 14 blocks into its own
    // buffer before committing any, and the refill below then only copies and
    // calls ggml_backend_tensor_set. So a throwing switch leaves the previous
    // embodiment whole and consistent with the selected_* metadata, which is
    // updated after both. `scratch` is handed to the refill rather than
    // recomputed there, so no rejection is left on the far side of the write.
    std::vector<uint8_t> src8;
    std::vector<uint8_t> dst8;
    size_t scratch = 0;
    if (m.wt_ready) {
      scratch = grootTransposedScratchBytes(m);
      src8.resize(scratch);
      dst8.resize(scratch);
    }
    grootFillEmbodimentRow(m, sel.row);
    // The pre-transposed copies are derived from the row that was just
    // replaced, so they have to be rebuilt. Shapes are identical across rows,
    // so ctx_wt / buf_wt are reused as allocated at load — only the contents
    // change. If the load-time materialization bailed (wt_ready=false), infer()
    // transposes at runtime from the new row and there is nothing to refresh.
    if (m.wt_ready) {
      grootFillTransposedWeights(m, src8, dst8, scratch);
    }
  }
  m.selected_embodiment_tag = sel.tag;
  m.selected_cat_id = sel.cat_id;
  m.selected_row = sel.row;
  m.num_cameras = sel.num_cameras;
  hparams_.num_cameras = sel.num_cameras;
  hparams_.selected_embodiment_tag = sel.tag;
  hparams_.selected_embodiment_cat_id = sel.cat_id;
  QLOG_IF(
      Priority::INFO,
      "GrootModel::setEmbodiment: embodiment '" + m.selected_embodiment_tag +
          "' (cat_id " + std::to_string(m.selected_cat_id) + ", " +
          (m.selected_row < 0
               ? "single-embodiment GGUF"
               : "stored row " + std::to_string(m.selected_row)) +
          ", num_cameras " + std::to_string(m.num_cameras) + ")");
}

bool GrootModel::infer(
    const float** images, int nImages, int imgWidth, int imgHeight,
    const float* state, int stateDim, const int32_t* langTokens,
    const bool* langMask, int langLen, const float* noise, float* actionsOut,
    int* nActionsOut, VlaTimingGeneric* timingOut) {
  // Composes the M4.1–M4.6 verified builders end-to-end (option b: everything
  // the fixed IVlaModel signature doesn't carry — M-RoPE position ids, the
  // image-token layout, deepstack scatter, per-step timestep embeddings — is
  // derived here C++-side, no interface extension). Contract:
  //   * images[i] = camera i's PRE-PATCHIFIED, merge-ordered patches, length
  //     patchesPerImage · inFlat (Gr00tPolicy does resize/normalize/patchify
  //     caller-side; the oracle `vision_input` hook is a forward-PRE hook on
  //     qwen.visual, so its input is already patchified). Camera order must
  //     match the order image-placeholder runs appear in langTokens.
  //   * state = per-embodiment-NORMALIZED state (Gr00tPolicy-side), length
  //     max_state_dim.
  //   * langTokens/langMask = tokenized prompt with `image_token_id` runs at
  //     the image positions; langMask marks valid (non-padding) tokens.
  //   * noise = sampled x_0, length action_horizon · max_action_dim.
  // Output unnormalization is consumer-side (Gr00tPolicy).
  auto& m = *impl_;
  if (actionsOut == nullptr || nActionsOut == nullptr || images == nullptr ||
      langTokens == nullptr || langMask == nullptr || state == nullptr ||
      noise == nullptr) {
    return false;
  }
  // Held for the whole inference: setEmbodiment rewrites buf_emb/buf_wt (the
  // CategorySpecificLinear weights read below) and runs on the JS thread while
  // this runs on the framework's JobRunner worker.
  const std::lock_guard<std::mutex> embodimentGuard(m.embodiment_mutex);
  const auto tStart = std::chrono::steady_clock::now();

  // ── Derived fixture dimensions ─────────────────────────────────────────
  // imgWidth/imgHeight must equal the pinned vision_image_size: the patch
  // geometry (and the per-camera buffer length the memcpy below trusts) is
  // fixed per model. Enforcing it here — not just deriving patchGrid from the
  // caller's imgWidth — keeps a caller-supplied width from driving patchGrid /
  // patchesPerImg past the buffer the JS validator sized against
  // image_patch_elems (defense-in-depth for the blind per-image memcpy).
  if (nImages < 1 || imgWidth <= 0 || imgWidth != imgHeight ||
      imgWidth != m.vision_image_size) {
    return false;
  }
  const int patchGrid = imgWidth / m.vision_patch_size; // 256/16 = 16
  const int merge = m.vision_spatial_merge_size;        // 2
  if (patchGrid <= 0 || merge <= 0 || patchGrid % merge != 0) {
    return false;
  }
  const int mergedGrid = patchGrid / merge;        // 8
  const int patchesPerImg = patchGrid * patchGrid; // 256
  const int inFlat = 3 * m.vision_temporal_patch_size * m.vision_patch_size *
                     m.vision_patch_size;           // 1536
  const int nVpos = nImages * patchesPerImg;        // 1024
  const int mergedPerImg = mergedGrid * mergedGrid; // 64
  const int nMerged = nImages * mergedPerImg;       // 256
  const int nTok = langLen;                         // 280
  const int hiddenDim = m.text_hidden_size;         // 2048
  const int outHidden = m.vision_out_hidden_size;   // 2048
  const int actInDim = m.input_embedding_dim;       // 1536
  const int nAct = m.action_horizon;                // 40
  const int actDim = m.max_action_dim;              // 132
  const int nSteps = m.num_inference_timesteps;     // 4
  const int nDeep = static_cast<int>(m.vision_deepstack_indexes.size());
  const int vHeadDim = m.vision_hidden_size / m.vision_num_heads; // 64
  constexpr float visionRopeBase = 10000.0f;
  constexpr float visionEps = 1e-6f;
  constexpr float vlfEps = 1e-5f;
  constexpr float ditEps = 1e-5f;
  const int timestepBuckets = m.dit_num_timestep_buckets;

  for (int i = 0; i < nImages; ++i) {
    if (images[i] == nullptr) {
      return false;
    }
  }
  if (stateDim != m.max_state_dim || outHidden != hiddenDim) {
    return false;
  }
  // Upper-bound the prompt length. The per-phase host staging arenas below are
  // fixed-size (text phase: 32 MB, holding inpE/deepstack ≈ nTok·hiddenDim and
  // the nTok² causal mask); an over-long prompt would overflow them and trip a
  // GGML_ASSERT hard-abort instead of returning cleanly. GR00T is continuous-
  // state (tokenizer_max_length=0), so the JS validator's exact-length guard
  // that bounds pi05 doesn't apply here. 512 leaves ~2x headroom over the
  // shipped 280-token LIBERO prompt; raising it means enlarging those arenas.
  if (nTok < 1 || nTok > 512) {
    return false;
  }
  // The prompt must carry exactly one image-placeholder token per merged patch.
  int nImgTok = 0;
  for (int t = 0; t < nTok; ++t) {
    // Reject out-of-range ids: get_rows(token_embd, langTokens) below would
    // otherwise read out of bounds on a bad id.
    if (langTokens[t] < 0 || langTokens[t] >= m.text_vocab_size) {
      return false;
    }
    if (langTokens[t] == m.image_token_id) {
      ++nImgTok;
    }
  }
  if (nImgTok != nMerged) {
    return false;
  }
  // The count check above is necessary but NOT sufficient for
  // grootDeriveMRopePositions: it treats every image_token_id as the start of a
  // full mergedGrid×mergedGrid grid and advances t by mergedPerImg, writing
  // positions[axis*nTok + (t + r*gw + col)]. Image tokens that are present in
  // the right total count but laid out as scattered singletons or short runs
  // would drive that index past the nTok*4 positions buffer — a heap OOB write,
  // not merely wrong output. Require exactly nImages disjoint contiguous runs
  // of exactly mergedPerImg image tokens each.
  int imgRuns = 0;
  for (int t = 0; t < nTok;) {
    if (langTokens[t] == m.image_token_id) {
      int run = 0;
      while (t + run < nTok && langTokens[t + run] == m.image_token_id) {
        ++run;
      }
      if (run != mergedPerImg) {
        return false;
      }
      ++imgRuns;
      t += run;
    } else {
      ++t;
    }
  }
  if (imgRuns != nImages) {
    return false;
  }

  // ── Phase 1: vision tower → merged image embeds + deepstack (to host) ───
  // Structural masks depend only on the token layout + counts (fixed across a
  // control episode), so cache them and reuse when the prompt is unchanged.
  bool masksHit = m.masks_valid && m.mask_sig_nTok == nTok &&
                  m.mask_sig_nImages == nImages &&
                  m.mask_sig_tokens.size() == static_cast<size_t>(nTok);
  for (int t = 0; masksHit && t < nTok; ++t) {
    if (m.mask_sig_tokens[t] != langTokens[t] ||
        m.mask_sig_mask[t] != (langMask[t] ? 1 : 0)) {
      masksHit = false;
    }
  }
  if (!masksHit) {
    m.mask_sig_tokens.assign(langTokens, langTokens + nTok);
    m.mask_sig_mask.resize(nTok);
    for (int t = 0; t < nTok; ++t) {
      m.mask_sig_mask[t] = langMask[t] ? 1 : 0;
    }
    m.mask_sig_nTok = nTok;
    m.mask_sig_nImages = nImages;
    // Invalidate until every mask cache is rebuilt AND the whole infer()
    // completes — an early failure below must not leave a matching signature
    // pointing at partially-filled caches. Set true only on the success path.
    m.masks_valid = false;
  }

  const auto tVisStart = std::chrono::steady_clock::now();
  auto& myVision = m.scratch_vision;
  myVision.resize(static_cast<size_t>(nMerged) * outHidden);
  auto& myDeep = m.scratch_deep;
  myDeep.resize(nDeep);
  {
    // `cHost` (no_alloc=false) STAGES the host-computed input data — the
    // patch-embed linear reshape, the exact-bilinear pos-embed table, the patch
    // input, the M-RoPE positions and the attention mask. `c` (no_alloc=true)
    // holds the graph; its input leaves are marked ggml_set_input and filled
    // from the cHost staging tensors with ggml_backend_tensor_set *after*
    // allocation (so the scheduler can place them in whichever backend buffer
    // it assigns — device memory on the GPU path). Weighted ops run on the GPU
    // when has_gpu (weights resident via the alloc+copy loader), else on the
    // CPU with ggml_gallocr lifetime-reuse of the transformer intermediates.
    // mem_buffer=nullptr lets ggml malloc (not zero-fill) the arena and own it;
    // every staged tensor is fully written before use, so no zeroing is needed.
    const size_t hostMem = size_t(128) * 1024u * 1024u;
    // The load-time guard bounds vision_image_size and vision_patch_size on
    // their own, but their ratio (patchGrid → patchesPerImg) and the resulting
    // staging footprint can still be inflated by a crafted GGUF until the fixed
    // arena below overflows and ggml_init trips a GGML_ASSERT hard-abort. Size
    // the staging tensors up front (all F32/I32 = 4 bytes) and reject cleanly
    // if they wouldn't fit, leaving margin for ggml's per-tensor headers.
    const int64_t stagingElems =
        static_cast<int64_t>(inFlat) * m.vision_hidden_size +        // wlin
        static_cast<int64_t>(m.vision_hidden_size) * patchesPerImg + // pe
        static_cast<int64_t>(inFlat) * nVpos +                       // pin
        static_cast<int64_t>(nVpos) * 4 +    // pos (i32)
        static_cast<int64_t>(nVpos) * nVpos; // mask
    if (stagingElems * 4 + (1 << 20) > static_cast<int64_t>(hostMem)) {
      return false;
    }
    struct ggml_init_params hip{hostMem, nullptr, false};
    struct ggml_context* cHost = ggml_init(hip);
    if (cHost == nullptr) {
      return false;
    }
    const size_t metaMem = size_t(64) * 1024u * 1024u;
    struct ggml_init_params ip{metaMem, nullptr, /*no_alloc=*/true};
    struct ggml_context* c = ggml_init(ip);
    if (c == nullptr) {
      ggml_free(cHost);
      return false;
    }
    // The patch-embed conv halves and the pos-embed table are read on the HOST
    // to build the linear weight and the interpolated pos-embed; on the GPU
    // path those weights live in device memory, so use the host copies staged
    // at load (see grootHostCopyTensor).
    const struct ggml_tensor* conv0 =
        m.has_gpu ? m.host_patch_embd_w : m.vision.patch_embd_w;
    const struct ggml_tensor* conv1 =
        m.has_gpu ? m.host_patch_embd_w1 : m.vision.patch_embd_w1;
    const struct ggml_tensor* posSrc =
        m.has_gpu ? m.host_position_embd : m.vision.position_embd;
    // Compute the patch-embed linear weight and the pos-embed table once and
    // cache the host results; both are functions of load-constant weights and
    // fixed geometry, so later calls skip the reshape/bilinear work and just
    // re-upload the cached staging data below.
    if (!m.vis_embed_cached) {
      struct ggml_tensor* wlin = grootBuildPatchEmbedLinear(
          cHost,
          conv0,
          conv1,
          m.vision_hidden_size,
          3,
          m.vision_temporal_patch_size,
          m.vision_patch_size);
      struct ggml_tensor* pe = grootBuildVisionPosEmbed(
          cHost,
          posSrc,
          patchGrid,
          patchGrid,
          merge,
          m.vision_num_position_embeddings,
          m.vision_hidden_size);
      if (wlin == nullptr || pe == nullptr) {
        ggml_free(c);
        ggml_free(cHost);
        return false;
      }
      const auto* wd = static_cast<const float*>(wlin->data);
      const auto* ped = static_cast<const float*>(pe->data);
      m.vis_wlin_cache.assign(wd, wd + ggml_nelements(wlin));
      m.vis_pe_cache.assign(ped, ped + ggml_nelements(pe));
      m.vis_embed_cached = true;
    }
    struct ggml_tensor* pin =
        ggml_new_tensor_2d(cHost, GGML_TYPE_F32, inFlat, nVpos);
    for (int i = 0; i < nImages; ++i) {
      std::memcpy(
          static_cast<float*>(pin->data) +
              static_cast<size_t>(i) * patchesPerImg * inFlat,
          images[i],
          static_cast<size_t>(patchesPerImg) * inFlat * sizeof(float));
    }
    // Merge-ordered spatial (h,w) indices for the vision M-RoPE, one image's
    // worth, tiled per image (matches M4.6's construction).
    std::vector<int32_t> sH(patchesPerImg), sW(patchesPerImg);
    int ptr = 0;
    for (int y = 0; y < patchGrid; y += merge) {
      for (int x = 0; x < patchGrid; x += merge) {
        for (int dy = 0; dy < merge; ++dy) {
          for (int dx = 0; dx < merge; ++dx) {
            sH[ptr] = y + dy;
            sW[ptr] = x + dx;
            ++ptr;
          }
        }
      }
    }
    struct ggml_tensor* pos =
        ggml_new_tensor_1d(cHost, GGML_TYPE_I32, nVpos * 4);
    auto* pp = static_cast<int32_t*>(pos->data);
    for (int p = 0; p < nVpos; ++p) {
      const int loc = p % patchesPerImg;
      pp[p] = sH[loc];
      pp[nVpos + p] = sW[loc];
      pp[2 * nVpos + p] = sH[loc];
      pp[3 * nVpos + p] = sW[loc];
    }
    // Block-diagonal per-image attention mask (cached across calls; rebuilt
    // only when the token signature changes — see masksHit above).
    if (!masksHit) {
      m.vis_mask_cache.resize(static_cast<size_t>(nVpos) * nVpos);
      auto* mp = m.vis_mask_cache.data();
      for (int q = 0; q < nVpos; ++q) {
        for (int s = 0; s < nVpos; ++s) {
          mp[size_t(q) * nVpos + s] =
              (s / patchesPerImg == q / patchesPerImg) ? 0.0f : -INFINITY;
        }
      }
    }
    // Graph-input mirrors of the staged tensors, filled post-alloc.
    struct ggml_tensor* wlinIn =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, inFlat, m.vision_hidden_size);
    struct ggml_tensor* peIn = ggml_new_tensor_2d(
        c, GGML_TYPE_F32, m.vision_hidden_size, patchesPerImg);
    struct ggml_tensor* pinIn =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, inFlat, nVpos);
    struct ggml_tensor* posIn = ggml_new_tensor_1d(c, GGML_TYPE_I32, nVpos * 4);
    struct ggml_tensor* maskIn =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, nVpos, nVpos);
    ggml_set_input(wlinIn);
    ggml_set_input(peIn);
    ggml_set_input(pinIn);
    ggml_set_input(posIn);
    ggml_set_input(maskIn);
    std::vector<struct ggml_tensor*> deep;
    struct ggml_tensor* vout = grootBuildVisionGraph(
        c,
        pinIn,
        wlinIn,
        m.vision.patch_embd_b,
        m.vision.position_embd,
        posIn,
        maskIn,
        m.vision,
        nImages,
        patchGrid,
        patchGrid,
        m.vision_hidden_size,
        m.vision_num_heads,
        vHeadDim,
        merge,
        m.vision_num_position_embeddings,
        outHidden,
        visionEps,
        visionRopeBase,
        m.vision_deepstack_indexes,
        &deep,
        /*outBlocks=*/nullptr,
        /*hostCtx=*/nullptr,
        /*precomputedPe=*/peIn);
    if (vout == nullptr) {
      ggml_free(c);
      ggml_free(cHost);
      return false;
    }
    struct ggml_cgraph* gf = ggml_new_graph_custom(c, 16384, false);
    ggml_build_forward_expand(gf, vout);
    for (auto* d : deep) {
      ggml_build_forward_expand(gf, d);
    }
    GrootSched& sg =
        m.sched_vision; // cached across calls; not freed on success
    if (!grootSchedAlloc(sg, m, gf)) {
      ggml_free(c);
      ggml_free(cHost);
      return false;
    }
    ggml_backend_tensor_set(
        wlinIn, m.vis_wlin_cache.data(), 0, ggml_nbytes(wlinIn));
    ggml_backend_tensor_set(peIn, m.vis_pe_cache.data(), 0, ggml_nbytes(peIn));
    ggml_backend_tensor_set(pinIn, pin->data, 0, ggml_nbytes(pinIn));
    ggml_backend_tensor_set(posIn, pos->data, 0, ggml_nbytes(posIn));
    ggml_backend_tensor_set(
        maskIn, m.vis_mask_cache.data(), 0, ggml_nbytes(maskIn));
    if (!grootSchedCompute(sg, m, gf)) {
      grootSchedFree(sg);
      ggml_free(c);
      ggml_free(cHost);
      return false;
    }
    ggml_backend_tensor_get(vout, myVision.data(), 0, ggml_nbytes(vout));
    for (int i = 0; i < nDeep; ++i) {
      myDeep[i].resize(static_cast<size_t>(nMerged) * outHidden);
      ggml_backend_tensor_get(
          deep[i], myDeep[i].data(), 0, ggml_nbytes(deep[i]));
    }
    ggml_free(c);
    ggml_free(cHost);
  }
  const auto tVisEnd = std::chrono::steady_clock::now();

  // ── Phase 2: text embeds (get_rows + vision splice) → text decoder ──────
  const auto tPrefillStart = std::chrono::steady_clock::now();
  auto& myBackbone = m.scratch_backbone;
  myBackbone.resize(static_cast<size_t>(nTok) * hiddenDim);
  {
    // 2a — token embeddings via get_rows(token_embd, langTokens), cast to F32.
    auto& embeds = m.scratch_embeds;
    embeds.resize(static_cast<size_t>(nTok) * hiddenDim);
    {
      const size_t metaMem = size_t(16) * 1024u * 1024u;
      struct ggml_init_params ip{metaMem, nullptr, /*no_alloc=*/true};
      struct ggml_context* c = ggml_init(ip);
      if (c == nullptr) {
        return false;
      }
      struct ggml_tensor* ids = ggml_new_tensor_1d(c, GGML_TYPE_I32, nTok);
      ggml_set_input(ids);
      struct ggml_tensor* emb = ggml_get_rows(c, m.text.token_embd_w, ids);
      emb = grootToF32(c, emb);
      struct ggml_cgraph* gf = ggml_new_graph_custom(c, 512, false);
      ggml_build_forward_expand(gf, emb);
      GrootSched& sg = m.sched_tokemb; // cached across calls
      if (!grootSchedAlloc(sg, m, gf)) {
        ggml_free(c);
        return false;
      }
      ggml_backend_tensor_set(
          ids, langTokens, 0, static_cast<size_t>(nTok) * sizeof(int32_t));
      if (!grootSchedCompute(sg, m, gf)) {
        grootSchedFree(sg);
        ggml_free(c);
        return false;
      }
      ggml_backend_tensor_get(emb, embeds.data(), 0, ggml_nbytes(emb));
      ggml_free(c);
    }
    // Splice MY vision embeds at image-placeholder positions (in appearance
    // order, matching camera order in `images`).
    int img = 0;
    for (int t = 0; t < nTok; ++t) {
      if (langTokens[t] == m.image_token_id) {
        std::memcpy(
            &embeds[static_cast<size_t>(t) * hiddenDim],
            &myVision[static_cast<size_t>(img) * outHidden],
            static_cast<size_t>(hiddenDim) * sizeof(float));
        ++img;
      }
    }

    // 2b — decoder.
    const size_t hostMem = size_t(32) * 1024u * 1024u;
    struct ggml_init_params hip{hostMem, nullptr, false};
    struct ggml_context* cHost = ggml_init(hip);
    if (cHost == nullptr) {
      return false;
    }
    const size_t metaMem = size_t(32) * 1024u * 1024u;
    struct ggml_init_params ip{metaMem, nullptr, /*no_alloc=*/true};
    struct ggml_context* c = ggml_init(ip);
    if (c == nullptr) {
      ggml_free(cHost);
      return false;
    }
    struct ggml_tensor* inpE =
        ggml_new_tensor_2d(cHost, GGML_TYPE_F32, hiddenDim, nTok);
    std::memcpy(inpE->data, embeds.data(), embeds.size() * sizeof(float));
    // Derived M-RoPE position ids (axis-major [4][nTok]).
    struct ggml_tensor* posT =
        ggml_new_tensor_1d(cHost, GGML_TYPE_I32, nTok * 4);
    grootDeriveMRopePositions(
        langTokens,
        nTok,
        m.image_token_id,
        mergedGrid,
        mergedGrid,
        static_cast<int32_t*>(posT->data));
    // Causal mask over valid tokens (cached across calls; see masksHit).
    if (!masksHit) {
      m.text_mask_cache.resize(static_cast<size_t>(nTok) * nTok);
      auto* mp = m.text_mask_cache.data();
      for (int q = 0; q < nTok; ++q) {
        for (int s = 0; s < nTok; ++s) {
          mp[size_t(q) * nTok + s] = (s <= q && langMask[s]) ? 0.0f : -INFINITY;
        }
      }
    }
    // Deepstack features scattered to image positions, zero elsewhere.
    std::vector<struct ggml_tensor*> ds(nDeep, nullptr);
    for (int i = 0; i < nDeep; ++i) {
      struct ggml_tensor* d =
          ggml_new_tensor_2d(cHost, GGML_TYPE_F32, hiddenDim, nTok);
      auto* dp = static_cast<float*>(d->data);
      std::memset(dp, 0, static_cast<size_t>(hiddenDim) * nTok * sizeof(float));
      int im = 0;
      for (int t = 0; t < nTok; ++t) {
        if (langTokens[t] == m.image_token_id) {
          std::memcpy(
              &dp[static_cast<size_t>(t) * hiddenDim],
              &myDeep[i][static_cast<size_t>(im) * hiddenDim],
              static_cast<size_t>(hiddenDim) * sizeof(float));
          ++im;
        }
      }
      ds[i] = d;
    }
    // Graph-input mirrors of the staged tensors, filled post-alloc.
    struct ggml_tensor* inpEIn =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, hiddenDim, nTok);
    struct ggml_tensor* posTIn = ggml_new_tensor_1d(c, GGML_TYPE_I32, nTok * 4);
    struct ggml_tensor* maskIn =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, nTok, nTok);
    ggml_set_input(inpEIn);
    ggml_set_input(posTIn);
    ggml_set_input(maskIn);
    std::vector<struct ggml_tensor*> dsIn(nDeep, nullptr);
    for (int i = 0; i < nDeep; ++i) {
      dsIn[i] = ggml_new_tensor_2d(c, GGML_TYPE_F32, hiddenDim, nTok);
      ggml_set_input(dsIn[i]);
    }
    struct ggml_tensor* out = grootBuildTextDecoderGraph(
        c,
        inpEIn,
        posTIn,
        maskIn,
        dsIn,
        m.text,
        m.text_num_layers,
        nTok,
        m.text_num_heads,
        m.text_num_kv_heads,
        m.text_head_dim,
        m.text_ffn_length,
        m.text_rope_freq_base,
        m.text_rope_sections,
        m.text_rms_norm_eps);
    if (out == nullptr) {
      ggml_free(c);
      ggml_free(cHost);
      return false;
    }
    struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
    ggml_build_forward_expand(gf, out);
    GrootSched& sg = m.sched_text; // cached across calls
    if (!grootSchedAlloc(sg, m, gf)) {
      ggml_free(c);
      ggml_free(cHost);
      return false;
    }
    ggml_backend_tensor_set(inpEIn, inpE->data, 0, ggml_nbytes(inpEIn));
    ggml_backend_tensor_set(posTIn, posT->data, 0, ggml_nbytes(posTIn));
    ggml_backend_tensor_set(
        maskIn, m.text_mask_cache.data(), 0, ggml_nbytes(maskIn));
    for (int i = 0; i < nDeep; ++i) {
      ggml_backend_tensor_set(dsIn[i], ds[i]->data, 0, ggml_nbytes(dsIn[i]));
    }
    if (!grootSchedCompute(sg, m, gf)) {
      grootSchedFree(sg);
      ggml_free(c);
      ggml_free(cHost);
      return false;
    }
    ggml_backend_tensor_get(out, myBackbone.data(), 0, ggml_nbytes(out));
    ggml_free(c);
    ggml_free(cHost);
  }
  const auto tPrefillEnd = std::chrono::steady_clock::now();

  // ── Phase 3: VL fusion + state encoder (features reused every step) ─────
  auto& myVl = m.scratch_vl;
  myVl.resize(static_cast<size_t>(nTok) * hiddenDim);
  std::vector<float> myState(static_cast<size_t>(actInDim));
  {
    const size_t metaMem = size_t(16) * 1024u * 1024u;
    struct ggml_init_params ip{metaMem, nullptr, /*no_alloc=*/true};
    struct ggml_context* c = ggml_init(ip);
    if (c == nullptr) {
      return false;
    }
    struct ggml_tensor* bb =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, hiddenDim, nTok);
    struct ggml_tensor* st =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, m.max_state_dim, 1);
    ggml_set_input(bb);
    ggml_set_input(st);
    GrootVlfusionOutputs vlo = grootBuildVlfusionGraph(
        c,
        bb,
        m.vlfusion,
        nTok,
        hiddenDim,
        m.vlfusion_num_heads,
        m.vlfusion_head_dim,
        vlfEps);
    const bool preT = m.wt_ready;
    const GrootLinearWeights se1 =
        preT
            ? GrootLinearWeights{m.wt_se_l1, m.embodiment.state_encoder_layer1.bias}
            : m.embodiment.state_encoder_layer1;
    const GrootLinearWeights se2 =
        preT
            ? GrootLinearWeights{m.wt_se_l2, m.embodiment.state_encoder_layer2.bias}
            : m.embodiment.state_encoder_layer2;
    struct ggml_tensor* sf = grootBuildCategoryMlpGraph(c, st, se1, se2, preT);
    if (vlo.fusion_out == nullptr || sf == nullptr) {
      ggml_free(c);
      return false;
    }
    struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
    ggml_build_forward_expand(gf, vlo.fusion_out);
    ggml_build_forward_expand(gf, sf);
    GrootSched& sg = m.sched_vlfusion; // cached across calls
    if (!grootSchedAlloc(sg, m, gf)) {
      ggml_free(c);
      return false;
    }
    ggml_backend_tensor_set(bb, myBackbone.data(), 0, ggml_nbytes(bb));
    ggml_backend_tensor_set(
        st, state, 0, static_cast<size_t>(m.max_state_dim) * sizeof(float));
    if (!grootSchedCompute(sg, m, gf)) {
      grootSchedFree(sg);
      ggml_free(c);
      return false;
    }
    ggml_backend_tensor_get(
        vlo.fusion_out, myVl.data(), 0, ggml_nbytes(vlo.fusion_out));
    ggml_backend_tensor_get(sf, myState.data(), 0, ggml_nbytes(sf));
    ggml_free(c);
  }

  // ── Phase 4: N-step Euler flow-matching loop ────────────────────────────
  // The DiT step graph + scheduler are built ONCE; the loop only re-sets the
  // per-step input leaves and recomputes. Rebuilding the graph/sched every step
  // (as an earlier version did) cost a ~14ms ggml_backend_sched_new per step.
  // Like pi05, step-invariant leaves are uploaded once on GPU (see below); only
  // the CPU gallocr path re-sets every leaf per step (it reuses the arena).
  const auto tOdeStart = std::chrono::steady_clock::now();
  std::vector<float> actions(static_cast<size_t>(nAct) * actDim);
  std::memcpy(actions.data(), noise, actions.size() * sizeof(float));
  const float dt = 1.0f / static_cast<float>(nSteps);
  const int tTok = nAct + 1;

  // Step-invariant cross-attention masks (depend on langMask/langTokens only;
  // cached across calls, rebuilt only when the token signature changes).
  if (!masksHit) {
    m.dit_im_cache.resize(static_cast<size_t>(tTok) * nTok);
    m.dit_tx_cache.resize(static_cast<size_t>(tTok) * nTok);
    for (int q = 0; q < tTok; ++q) {
      for (int s = 0; s < nTok; ++s) {
        const bool valid = langMask[s];
        const bool isImg = langTokens[s] == m.image_token_id;
        m.dit_im_cache[size_t(q) * nTok + s] =
            (valid && isImg) ? 0.0f : -INFINITY;
        m.dit_tx_cache[size_t(q) * nTok + s] =
            (valid && !isImg) ? 0.0f : -INFINITY;
      }
    }
  }

  const size_t metaMem = size_t(16) * 1024u * 1024u;
  struct ggml_init_params ip{metaMem, nullptr, /*no_alloc=*/true};
  struct ggml_context* c = ggml_init(ip);
  if (c == nullptr) {
    return false;
  }
  // Graph inputs (re-set each step; see the re-set note in the loop).
  struct ggml_tensor* actT = ggml_new_tensor_2d(c, GGML_TYPE_F32, actDim, nAct);
  struct ggml_tensor* stateFeat =
      ggml_new_tensor_2d(c, GGML_TYPE_F32, actInDim, 1);
  struct ggml_tensor* vl =
      ggml_new_tensor_2d(c, GGML_TYPE_F32, hiddenDim, nTok);
  struct ggml_tensor* proj =
      ggml_new_tensor_1d(c, GGML_TYPE_F32, m.timestep_proj_channels);
  struct ggml_tensor* tau = ggml_new_tensor_1d(c, GGML_TYPE_F32, actInDim);
  struct ggml_tensor* imMask = ggml_new_tensor_2d(c, GGML_TYPE_F32, nTok, tTok);
  struct ggml_tensor* txMask = ggml_new_tensor_2d(c, GGML_TYPE_F32, nTok, tTok);
  ggml_set_input(actT);
  ggml_set_input(stateFeat);
  ggml_set_input(vl);
  ggml_set_input(proj);
  ggml_set_input(tau);
  ggml_set_input(imMask);
  ggml_set_input(txMask);
  struct ggml_tensor* temb = grootBuildTimestepMlpGraph(
      c,
      proj,
      m.dit.timestep_embedder_l1_w,
      m.dit.timestep_embedder_l1_b,
      m.dit.timestep_embedder_l2_w,
      m.dit.timestep_embedder_l2_b);
  const bool preT = m.wt_ready;
  const GrootLinearWeights aeW1 =
      preT ? GrootLinearWeights{m.wt_ae_w1, m.embodiment.action_encoder_w1.bias}
           : m.embodiment.action_encoder_w1;
  const GrootLinearWeights aeW2 =
      preT ? GrootLinearWeights{m.wt_ae_w2, m.embodiment.action_encoder_w2.bias}
           : m.embodiment.action_encoder_w2;
  const GrootLinearWeights aeW3 =
      preT ? GrootLinearWeights{m.wt_ae_w3, m.embodiment.action_encoder_w3.bias}
           : m.embodiment.action_encoder_w3;
  struct ggml_tensor* af = grootBuildActionEncoderGraph(
      c, actT, tau, aeW1, aeW2, aeW3, actInDim, nAct, preT);
  struct ggml_tensor* pemb = ggml_view_2d(
      c,
      m.dit.position_embedding_w,
      actInDim,
      nAct,
      m.dit.position_embedding_w->nb[1],
      0);
  af = ggml_add(c, af, pemb);
  struct ggml_tensor* sa = ggml_concat(c, stateFeat, af, 1);
  struct ggml_tensor* out = grootBuildDitGraph(
      c,
      sa,
      temb,
      vl,
      imMask,
      txMask,
      m.dit,
      m.dit_num_layers,
      m.dit_num_heads,
      m.dit_head_dim,
      actInDim,
      hiddenDim,
      m.dit_ffn_inner,
      m.dit_output_dim,
      m.dit_attend_text_every_n_blocks,
      ditEps,
      nullptr);
  if (out == nullptr) {
    ggml_free(c);
    return false;
  }
  const GrootLinearWeights adL1 =
      preT
          ? GrootLinearWeights{m.wt_ad_l1, m.embodiment.action_decoder_layer1.bias}
          : m.embodiment.action_decoder_layer1;
  const GrootLinearWeights adL2 =
      preT
          ? GrootLinearWeights{m.wt_ad_l2, m.embodiment.action_decoder_layer2.bias}
          : m.embodiment.action_decoder_layer2;
  struct ggml_tensor* pred =
      grootBuildCategoryMlpGraph(c, out, adL1, adL2, preT);
  // Drop the leading state token → velocity [actDim, nAct].
  struct ggml_tensor* vel = ggml_cont(
      c, ggml_view_2d(c, pred, actDim, nAct, pred->nb[1], pred->nb[1]));
  ggml_set_output(vel);
  struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
  ggml_build_forward_expand(gf, vel);
  GrootSched& sg =
      m.sched_dit; // cached across calls (also reused per Euler step)
  if (!grootSchedAlloc(sg, m, gf)) {
    ggml_free(c);
    return false;
  }

  std::vector<float> projBuf(m.timestep_proj_channels);
  std::vector<float> tauBuf(actInDim);
  std::vector<float> velBuf(actions.size());
  // Upload the step-invariant leaves (stateFeat, vl ≈ nTok·hiddenDim, the two
  // cross-attn masks) ONCE on the GPU path — the reused sched keeps their
  // device buffers alloc'd across all nSteps compute calls, so re-uploading
  // them every step (as before) was redundant H2D bandwidth. The CPU gallocr
  // path packs inputs alongside reused intermediates, so it still must refill
  // them in-loop. Matches pi05's split. actT/proj/tau change per step and are
  // always in-loop.
  if (m.has_gpu) {
    ggml_backend_tensor_set(
        stateFeat, myState.data(), 0, ggml_nbytes(stateFeat));
    ggml_backend_tensor_set(vl, myVl.data(), 0, ggml_nbytes(vl));
    ggml_backend_tensor_set(
        imMask, m.dit_im_cache.data(), 0, ggml_nbytes(imMask));
    ggml_backend_tensor_set(
        txMask, m.dit_tx_cache.data(), 0, ggml_nbytes(txMask));
  }
  bool odeOk = true;
  for (int step = 0; step < nSteps; ++step) {
    // Discretized integer bucket, matching the reference's int() truncation
    // (see grootComputeTimestepProj's header). No-op when num_timestep_buckets
    // is a multiple of num_inference_timesteps (the shipped 1000/4 case), but
    // correct for configs where the division isn't exact.
    const float bucket = std::floor(
        static_cast<float>(step) * timestepBuckets /
        static_cast<float>(nSteps));
    grootComputeTimestepProj(bucket, m.timestep_proj_channels, projBuf.data());
    grootComputeActionTauEnc(bucket, actInDim, tauBuf.data());
    // actions/proj/tau change every step on both paths. The invariant leaves
    // (stateFeat/vl/imMask/txMask) were uploaded once before the loop on GPU;
    // the CPU gallocr path refills them here (it reuses the arena per compute).
    ggml_backend_tensor_set(actT, actions.data(), 0, ggml_nbytes(actT));
    ggml_backend_tensor_set(proj, projBuf.data(), 0, ggml_nbytes(proj));
    ggml_backend_tensor_set(tau, tauBuf.data(), 0, ggml_nbytes(tau));
    if (!m.has_gpu) {
      ggml_backend_tensor_set(
          stateFeat, myState.data(), 0, ggml_nbytes(stateFeat));
      ggml_backend_tensor_set(vl, myVl.data(), 0, ggml_nbytes(vl));
      ggml_backend_tensor_set(
          imMask, m.dit_im_cache.data(), 0, ggml_nbytes(imMask));
      ggml_backend_tensor_set(
          txMask, m.dit_tx_cache.data(), 0, ggml_nbytes(txMask));
    }
    if (!grootSchedCompute(sg, m, gf)) {
      odeOk = false;
      break;
    }
    ggml_backend_tensor_get(vel, velBuf.data(), 0, ggml_nbytes(vel));
    for (size_t i = 0; i < actions.size(); ++i) {
      actions[i] += dt * velBuf[i];
    }
  }
  // Keep the scheduler cached for the next call on success; free it only on
  // failure to leave clean state (the model is unusable past a compute error).
  if (!odeOk) {
    grootSchedFree(sg);
  }
  ggml_free(c);
  if (!odeOk) {
    return false;
  }
  const auto tOdeEnd = std::chrono::steady_clock::now();

  std::memcpy(actionsOut, actions.data(), actions.size() * sizeof(float));
  *nActionsOut = nAct;

  if (timingOut != nullptr) {
    const auto tEnd = std::chrono::steady_clock::now();
    auto toMs = [](auto a, auto b) {
      return std::chrono::duration<double, std::milli>(b - a).count();
    };
    timingOut->vision_ms = toMs(tVisStart, tVisEnd);
    timingOut->prefill_compute_ms = toMs(tPrefillStart, tPrefillEnd);
    timingOut->prefill_total_ms = toMs(tPrefillStart, tPrefillEnd);
    timingOut->ode_ms = toMs(tOdeStart, tOdeEnd);
    timingOut->total_ms = toMs(tStart, tEnd);
  }
  // All mask caches are now fully populated for the current signature; a later
  // call with an identical prompt can safely reuse them (masksHit above).
  m.masks_valid = true;
  return true;
}

} // namespace qvac_lib_infer_vla_ggml
