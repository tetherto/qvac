// Multi-embodiment load-time selection — grootResolveEmbodiment unit tests.
// The resolver is the pure table -> row + num_cameras logic pulled out of
// grootLoadModel; testing it directly exercises the load-time override and all
// its error paths without a multi-GB model load. No GGUF, no ggml.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/groot.hpp"
#include "model-interface/model_factory.hpp"

using qvac_lib_infer_vla_ggml::ggufGetI32ArrOr;
using qvac_lib_infer_vla_ggml::grootCheckEmbodimentCount;
using qvac_lib_infer_vla_ggml::grootCheckEmbodimentSliceShape;
using qvac_lib_infer_vla_ggml::grootCheckV1EmbodimentRank;
using qvac_lib_infer_vla_ggml::grootEmbodimentRowOffset;
using qvac_lib_infer_vla_ggml::GrootEmbodimentSelection;
using qvac_lib_infer_vla_ggml::grootResolveEmbodiment;
using qvac_lib_infer_vla_ggml::VlaEmbodimentRequest;

namespace {

// A small synthetic multi-embodiment table: 3 known tags (cat_ids 10/20/30), of
// which only A and C are shipped (B is mapped but not stored), with per-row
// camera counts 2 and 4. Baked/default tag is A.
const std::vector<std::string> TAGS = {"A", "B", "C"};
const std::vector<int> CAT_IDS = {10, 20, 30};
const std::vector<int> STORED = {10, 30};
const std::vector<int> STORED_CAMS = {2, 4};

GrootEmbodimentSelection resolveReq(
    const VlaEmbodimentRequest& request,
    const std::vector<int>& storedCams = STORED_CAMS, int defaultCams = 2) {
  return grootResolveEmbodiment(
      TAGS,
      CAT_IDS,
      STORED,
      storedCams,
      /*bakedTag=*/"A",
      /*bakedCatId=*/10,
      /*defaultTag=*/"A",
      request,
      defaultCams);
}

GrootEmbodimentSelection resolve(
    const std::string& requested,
    const std::vector<int>& storedCams = STORED_CAMS, int defaultCams = 2) {
  return resolveReq(VlaEmbodimentRequest{requested}, storedCams, defaultCams);
}

} // namespace

TEST(GrootEmbodimentResolve, DefaultSelectsBakedRow) {
  const GrootEmbodimentSelection sel = resolve("");
  EXPECT_EQ(sel.tag, "A");
  EXPECT_EQ(sel.cat_id, 10);
  EXPECT_EQ(sel.row, 0);
  EXPECT_EQ(sel.num_cameras, 2);
}

TEST(GrootEmbodimentResolve, ExplicitNonDefaultSelectsItsRow) {
  const GrootEmbodimentSelection sel = resolve("C");
  EXPECT_EQ(sel.tag, "C");
  EXPECT_EQ(sel.cat_id, 30);
  EXPECT_EQ(sel.row, 1);
  EXPECT_EQ(sel.num_cameras, 4); // per-row override, not the default 2
}

TEST(GrootEmbodimentResolve, UnknownTagThrows) {
  EXPECT_THROW(resolve("Z"), std::runtime_error);
}

TEST(GrootEmbodimentResolve, MappedButUnshippedCatIdThrows) {
  // B (cat_id 20) is in the full map but not in the ship set.
  EXPECT_THROW(resolve("B"), std::runtime_error);
}

TEST(GrootEmbodimentResolve, UnknownDefaultRowCamerasThrows) {
  // Selected row's camera count is 0 (unknown). Even though a valid top-level
  // default (2) is present, a multi GGUF must NOT inherit it — the per-row
  // count is authoritative, so an unknown count is rejected, not silently
  // filled with another embodiment's view count.
  EXPECT_THROW(
      resolve("A", /*storedCams=*/{0, 4}, /*defaultCams=*/2),
      std::runtime_error);
}

TEST(GrootEmbodimentResolve, UnknownNonDefaultRowCamerasThrows) {
  // Selecting a non-default row whose stored count is 0 (unknown) throws rather
  // than falling back to the default embodiment's count.
  EXPECT_THROW(
      resolve("C", /*storedCams=*/{2, 0}, /*defaultCams=*/2),
      std::runtime_error);
}

// ── Selection by numeric cat_id ───────────────────────────────────────────

TEST(GrootEmbodimentResolve, CatIdSelectsItsRow) {
  VlaEmbodimentRequest req;
  req.cat_id = 30;
  const GrootEmbodimentSelection sel = resolveReq(req);
  EXPECT_EQ(sel.cat_id, 30);
  EXPECT_EQ(sel.row, 1);
  EXPECT_EQ(sel.num_cameras, 4);
  // The id resolves back to its canonical tag so hparams stays readable.
  EXPECT_EQ(sel.tag, "C");
}

TEST(GrootEmbodimentResolve, CatIdZeroIsASelectionNotAnUnsetRequest) {
  // cat_id 0 is a real embodiment id; only a negative value means "unset". A
  // resolver that treated 0 as unset would silently hand back the default row.
  VlaEmbodimentRequest req;
  req.cat_id = 0;
  EXPECT_THROW(resolveReq(req), std::runtime_error); // 0 is not in the ship set
  const GrootEmbodimentSelection sel = grootResolveEmbodiment(
      /*tags=*/{"Z"},
      /*catIds=*/{0},
      /*storedCatIds=*/{0},
      /*storedNumCameras=*/{2},
      "Z",
      0,
      "Z",
      req,
      2);
  EXPECT_EQ(sel.cat_id, 0);
  EXPECT_EQ(sel.row, 0);
}

TEST(GrootEmbodimentResolve, CatIdOutsideShipSetThrows) {
  VlaEmbodimentRequest req;
  req.cat_id = 20; // mapped to tag B, but not stored
  EXPECT_THROW(resolveReq(req), std::runtime_error);
}

TEST(GrootEmbodimentResolve, CatIdAbsentFromTagMapGetsSyntheticTag) {
  // A shipped row whose cat_id the tag map doesn't cover is still selectable by
  // id; it reports a synthetic tag rather than an empty one.
  VlaEmbodimentRequest req;
  req.cat_id = 30;
  const GrootEmbodimentSelection sel = grootResolveEmbodiment(
      /*tags=*/{"A"},
      /*catIds=*/{10},
      STORED,
      STORED_CAMS,
      "A",
      10,
      "A",
      req,
      2);
  EXPECT_EQ(sel.cat_id, 30);
  EXPECT_EQ(sel.row, 1);
  EXPECT_EQ(sel.tag, "cat_id_30");
}

TEST(GrootEmbodimentResolve, CatIdAboveIdSpaceThrows) {
  // 32 is one past the architecture's category-bank size, so no conversion of
  // any checkpoint can hold it. Rejected as an out-of-range id rather than as a
  // ship-set miss, and INT32_MAX must not wrap into a valid row either.
  VlaEmbodimentRequest req;
  req.cat_id = 32;
  EXPECT_THROW(resolveReq(req), std::runtime_error);
  req.cat_id = 2147483647;
  EXPECT_THROW(resolveReq(req), std::runtime_error);
}

TEST(GrootEmbodimentResolve, CatIdAtTopOfIdSpaceIsAccepted) {
  // 31 is in range: it resolves against the ship set like any other id, so a
  // GGUF that stores it can select it.
  VlaEmbodimentRequest req;
  req.cat_id = 31;
  EXPECT_THROW(resolveReq(req), std::runtime_error); // not in this ship set
  const GrootEmbodimentSelection sel = grootResolveEmbodiment(
      /*tags=*/{"Z"},
      /*catIds=*/{31},
      /*storedCatIds=*/{31},
      /*storedNumCameras=*/{2},
      "Z",
      31,
      "Z",
      req,
      2);
  EXPECT_EQ(sel.cat_id, 31);
  EXPECT_EQ(sel.row, 0);
}

TEST(GrootEmbodimentResolve, TagAndCatIdTogetherThrows) {
  VlaEmbodimentRequest req;
  req.tag = "C";
  req.cat_id = 30; // even though they agree
  EXPECT_THROW(resolveReq(req), std::runtime_error);
}

// ── Camera-count override ─────────────────────────────────────────────────

TEST(GrootEmbodimentResolve, OverrideMakesUnknownCameraRowSelectable) {
  // The whole point of the override: a row stored with count 0 (unknown at
  // conversion time) is runnable once the caller states its view count.
  VlaEmbodimentRequest req;
  req.tag = "C";
  req.num_cameras = 3;
  const GrootEmbodimentSelection sel =
      resolveReq(req, /*storedCams=*/{2, 0}, /*defaultCams=*/2);
  EXPECT_EQ(sel.row, 1);
  EXPECT_EQ(sel.num_cameras, 3);
}

TEST(GrootEmbodimentResolve, OverrideWinsOverStoredCount) {
  // Counts are stored per cat_id, so a rig whose view count differs from the
  // stored one has no other way to be run. The override wins (and warns).
  VlaEmbodimentRequest req;
  req.tag = "C";
  req.num_cameras = 3;
  EXPECT_EQ(resolveReq(req).num_cameras, 3);
}

TEST(GrootEmbodimentResolve, OverrideAppliesToCatIdSelection) {
  VlaEmbodimentRequest req;
  req.cat_id = 30;
  req.num_cameras = 1;
  const GrootEmbodimentSelection sel =
      resolveReq(req, /*storedCams=*/{2, 0}, /*defaultCams=*/2);
  EXPECT_EQ(sel.num_cameras, 1);
}

TEST(GrootEmbodimentResolve, OverrideAppliesToTheDefaultRow) {
  // No tag/id named: the default row is selected and the override still
  // applies.
  VlaEmbodimentRequest req;
  req.num_cameras = 5;
  const GrootEmbodimentSelection sel =
      resolveReq(req, /*storedCams=*/{0, 4}, /*defaultCams=*/2);
  EXPECT_EQ(sel.tag, "A");
  EXPECT_EQ(sel.row, 0);
  EXPECT_EQ(sel.num_cameras, 5);
}

TEST(GrootEmbodimentResolve, OverrideAboveSanityBoundThrows) {
  VlaEmbodimentRequest req;
  req.tag = "C";
  req.num_cameras = 65;
  EXPECT_THROW(resolveReq(req), std::runtime_error);
}

TEST(GrootEmbodimentResolve, OverrideOnSingleEmbodimentGgufApplies) {
  VlaEmbodimentRequest req;
  req.num_cameras = 3;
  const GrootEmbodimentSelection sel =
      grootResolveEmbodiment({}, {}, {}, {}, "A", 10, "A", req, 2);
  EXPECT_EQ(sel.row, -1);
  EXPECT_EQ(sel.num_cameras, 3);
}

// ── v1 single-embodiment GGUF (empty stored-cat-id table) ─────────────────

TEST(GrootEmbodimentResolve, SingleEmbodimentDefaultOk) {
  const GrootEmbodimentSelection sel = grootResolveEmbodiment(
      {},
      {},
      /*storedCatIds=*/{},
      /*storedNumCameras=*/{},
      /*bakedTag=*/"A",
      /*bakedCatId=*/10,
      /*defaultTag=*/"A",
      /*request=*/{},
      /*defaultNumCameras=*/2);
  EXPECT_EQ(sel.tag, "A");
  EXPECT_EQ(sel.cat_id, 10);
  EXPECT_EQ(sel.row, -1); // no slice; weights are already 2-D on disk
  EXPECT_EQ(sel.num_cameras, 2);
}

TEST(GrootEmbodimentResolve, SingleEmbodimentBakedTagOk) {
  const GrootEmbodimentSelection sel = grootResolveEmbodiment(
      {}, {}, {}, {}, "A", 10, "A", VlaEmbodimentRequest{"A"}, 2);
  EXPECT_EQ(sel.row, -1);
  EXPECT_EQ(sel.cat_id, 10);
}

TEST(GrootEmbodimentResolve, SingleEmbodimentRejectsOverride) {
  EXPECT_THROW(
      grootResolveEmbodiment(
          {}, {}, {}, {}, "A", 10, "A", VlaEmbodimentRequest{"B"}, 2),
      std::runtime_error);
}

TEST(GrootEmbodimentResolve, SingleEmbodimentAcceptsBakedCatId) {
  VlaEmbodimentRequest req;
  req.cat_id = 10;
  const GrootEmbodimentSelection sel =
      grootResolveEmbodiment({}, {}, {}, {}, "A", 10, "A", req, 2);
  EXPECT_EQ(sel.tag, "A");
  EXPECT_EQ(sel.row, -1);
}

TEST(GrootEmbodimentResolve, SingleEmbodimentRejectsOtherCatId) {
  VlaEmbodimentRequest req;
  req.cat_id = 30;
  EXPECT_THROW(
      grootResolveEmbodiment({}, {}, {}, {}, "A", 10, "A", req, 2),
      std::runtime_error);
}

// ── Malformed / degenerate multi-embodiment tables ────────────────────────

TEST(GrootEmbodimentResolve, MismatchedTagMapLengthThrows) {
  // Multi GGUF (STORED non-empty) but the tag->cat_id map arrays disagree in
  // length — a corrupt/truncated table. Fail with a specific error rather than
  // silently ignoring the map.
  EXPECT_THROW(
      grootResolveEmbodiment(
          /*tags=*/{"A", "B"},
          /*catIds=*/{10},
          /*storedCatIds=*/{10},
          /*storedNumCameras=*/{2},
          "A",
          10,
          "A",
          /*request=*/{},
          2),
      std::runtime_error);
}

TEST(GrootEmbodimentResolve, EmptyTagMapFallsBackToBakedCatId) {
  // Multi GGUF with no full tag->cat_id map: the default/baked tag still
  // resolves via bakedCatId to its stored row.
  const GrootEmbodimentSelection sel = grootResolveEmbodiment(
      /*tags=*/{},
      /*catIds=*/{},
      /*storedCatIds=*/{10},
      /*storedNumCameras=*/{2},
      "A",
      10,
      "A",
      /*request=*/{},
      2);
  EXPECT_EQ(sel.tag, "A");
  EXPECT_EQ(sel.cat_id, 10);
  EXPECT_EQ(sel.row, 0);
  EXPECT_EQ(sel.num_cameras, 2);
}

TEST(GrootEmbodimentResolve, OversizedStoredTableThrows) {
  // A ship set beyond the sanity bound (65 rows) is a corrupt table: on the GPU
  // path the matching tensor dimension sizes a host block, so reject it at
  // resolution rather than allocate from it.
  std::vector<int> stored(65);
  std::vector<int> cams(65, 2);
  for (size_t i = 0; i < stored.size(); ++i) {
    stored[i] = static_cast<int>(i);
  }
  EXPECT_THROW(
      grootResolveEmbodiment(
          /*tags=*/{"A"},
          /*catIds=*/{0},
          stored,
          cams,
          "A",
          0,
          "A",
          /*request=*/{},
          2),
      std::runtime_error);
}

// ── num_cameras sanity bound (upper edge = 64) ────────────────────────────

TEST(GrootEmbodimentResolve, NumCamerasAtUpperBoundOk) {
  const GrootEmbodimentSelection sel =
      resolve("A", /*storedCams=*/{64, 4}, /*defaultCams=*/2);
  EXPECT_EQ(sel.num_cameras, 64);
}

TEST(GrootEmbodimentResolve, NumCamerasAboveUpperBoundThrows) {
  EXPECT_THROW(
      resolve("A", /*storedCams=*/{65, 4}, /*defaultCams=*/2),
      std::runtime_error);
}

// ── Slice-shape validation (metadata vs tensor row dims) ──────────────────

TEST(GrootEmbodimentSliceShape, OneRowShipSetIsValid) {
  // `--embodiments <one tag>` stores ne=[out,in,1] / [out,1]. ggml_n_dims
  // collapses those trailing singletons, so the old rank test read this as an
  // already-sliced v1 weight and rejected a valid GGUF. Row 0 of 1 must pass.
  EXPECT_NO_THROW(grootCheckEmbodimentSliceShape(
      /*weightRowDim=*/1, /*biasRowDim=*/1, /*nStored=*/1, /*rowIndex=*/0));
}

TEST(GrootEmbodimentSliceShape, FullShipSetIsValid) {
  EXPECT_NO_THROW(grootCheckEmbodimentSliceShape(17, 17, 17, 0));
  EXPECT_NO_THROW(grootCheckEmbodimentSliceShape(17, 17, 17, 16));
}

TEST(GrootEmbodimentSliceShape, RowDimDisagreeingWithTableThrows) {
  // Table says 17 rows, tensors carry 1 (or vice versa): the file's metadata
  // and its tensors disagree, so row 0 might not be the requested embodiment.
  EXPECT_THROW(grootCheckEmbodimentSliceShape(1, 1, 17, 0), std::runtime_error);
  EXPECT_THROW(
      grootCheckEmbodimentSliceShape(17, 17, 1, 0), std::runtime_error);
  // Weight and bias disagreeing with each other is caught too.
  EXPECT_THROW(
      grootCheckEmbodimentSliceShape(17, 1, 17, 0), std::runtime_error);
}

TEST(GrootEmbodimentSliceShape, RowOutOfRangeThrows) {
  EXPECT_THROW(
      grootCheckEmbodimentSliceShape(17, 17, 17, 17), std::runtime_error);
  EXPECT_THROW(
      grootCheckEmbodimentSliceShape(17, 17, 17, -1), std::runtime_error);
}

TEST(GrootEmbodimentSliceShape, InsaneStoredCountThrows) {
  EXPECT_THROW(grootCheckEmbodimentSliceShape(0, 0, 0, 0), std::runtime_error);
  EXPECT_THROW(
      grootCheckEmbodimentSliceShape(65, 65, 65, 0), std::runtime_error);
  EXPECT_NO_THROW(grootCheckEmbodimentSliceShape(64, 64, 64, 63));
}

// ── Corrupt-metadata guards ────────────────────────────────────────────────
// These cover the load-time rejections that would otherwise need a
// purpose-built corrupt multi-GB GGUF. Each is the pure half of a check
// grootLoadModel / grootSliceEmbodiment perform, so the error path runs here
// even though the full load path cannot be exercised without a fixture.

// A v1 GGUF has exactly one embodiment row. More than one means the file
// carries a stored bank whose table could not be read, which used to load
// "successfully" and then abort the process inside ggml on the first infer.
TEST(GrootEmbodimentV1Rank, MultiRowWithoutTableThrows) {
  EXPECT_NO_THROW(grootCheckV1EmbodimentRank(1));
  // A one-row ship set also reads back as ne[2] == 1, which is exactly why the
  // rank cannot be the multi/v1 discriminator — it must not throw here either.
  EXPECT_THROW(grootCheckV1EmbodimentRank(2), std::runtime_error);
  EXPECT_THROW(grootCheckV1EmbodimentRank(17), std::runtime_error);
}

TEST(GrootEmbodimentCount, DisagreeingCountThrows) {
  EXPECT_NO_THROW(grootCheckEmbodimentCount(17, 17));
  EXPECT_THROW(grootCheckEmbodimentCount(16, 17), std::runtime_error);
  EXPECT_THROW(grootCheckEmbodimentCount(18, 17), std::runtime_error);
  // grootLoadModel passes the table length when the key is absent, so an older
  // file that omits it is a no-op rather than a mismatch.
  EXPECT_NO_THROW(grootCheckEmbodimentCount(0, 0));
}

TEST(GrootEmbodimentRowOffset, ComputesContiguousRowOffsets) {
  EXPECT_EQ(grootEmbodimentRowOffset(1000, 0, 64), 1000u);
  EXPECT_EQ(grootEmbodimentRowOffset(1000, 3, 64), 1192u);
  EXPECT_NO_THROW(grootEmbodimentRowOffset(0, 0, 0));
}

TEST(GrootEmbodimentRowOffset, OverflowThrows) {
  // row * row_bytes wraps.
  EXPECT_THROW(
      grootEmbodimentRowOffset(0, 63, SIZE_MAX / 8), std::runtime_error);
  // The multiply fits but file_offset + row_off wraps.
  EXPECT_THROW(
      grootEmbodimentRowOffset(SIZE_MAX - 10, 1, 64), std::runtime_error);
}

// ── Corrupt metadata THROUGH the real load path ────────────────────────────
// The tests above prove the checks reject what they should; these prove
// grootLoadModel actually calls them, which is the part a guard that was
// written but never wired up would pass silently.
//
// All four rejections fire before grootLoadModel requires the model's tensors
// to exist, so a few-KB GGUF reaches every one of them. The first two need no
// tensors at all. The other two — rank-3 weights with no table, and a
// table/tensor row-count disagreement — read a tensor's `ne` extents and
// nothing else, which is why grootCheckEmbodimentTensorRankEarly runs them off
// a probe tensor before mustGet rather than only from grootSliceEmbodiment
// afterwards. A 4x4 stand-in for the first embodiment linear is enough; no
// multi-GB fixture is involved.
namespace {

// Write a metadata-only GGUF carrying just enough for the groot loader to
// start.
std::string writeMetaOnlyGguf(
    const std::string& name,
    const std::function<void(struct gguf_context*)>& addKeys) {
  struct gguf_context* g = gguf_init_empty();
  if (g == nullptr) {
    throw std::runtime_error("gguf_init_empty failed");
  }
  gguf_set_val_str(g, "general.architecture", "groot");
  // grootLoadModel rejects a file with no baked tag / cat_id before it ever
  // reads the ship-set table, so these are required for the corrupt-table
  // checks below to be the reason the load fails.
  gguf_set_val_str(g, "groot.embodiment_tag", "libero_sim");
  gguf_set_val_u32(g, "groot.embodiment_cat_id", 2);
  addKeys(g);
  const std::string path = std::string(::testing::TempDir()) + name;
  const bool ok = gguf_write_to_file(g, path.c_str(), /*only_meta=*/true);
  gguf_free(g);
  if (!ok) {
    throw std::runtime_error("gguf_write_to_file failed for " + path);
  }
  return path;
}

// Same file, plus a tiny stand-in for the first embodiment linear shaped
// [OUT, IN, rows] / [OUT, rows] — the tensor
// grootCheckEmbodimentTensorRankEarly probes. 4x4 extents keep it a few KB; the
// checks read `ne` only, so the zeroed data is never looked at.
//
// Written with only_meta=false on purpose: a GGUF that declares tensor infos
// without the matching data blob is rejected by gguf_init_from_file itself, and
// the load would fail before reaching any check under test.
std::string writeGgufWithEmbodimentProbe(
    const std::string& name, int64_t rows,
    const std::function<void(struct gguf_context*)>& addKeys) {
  constexpr int64_t outDim = 4;
  constexpr int64_t inDim = 4;
  struct ggml_init_params ip{
      ggml_tensor_overhead() * 4 +
          static_cast<size_t>(outDim * (inDim + 1) * rows) * sizeof(float) +
          1024,
      nullptr,
      /*no_alloc=*/false};
  struct ggml_context* ctx = ggml_init(ip);
  if (ctx == nullptr) {
    throw std::runtime_error("ggml_init failed");
  }
  struct ggml_tensor* w =
      ggml_new_tensor_3d(ctx, GGML_TYPE_F32, outDim, inDim, rows);
  struct ggml_tensor* b = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, outDim, rows);
  ggml_set_name(w, "embodiment.state_encoder.layer1.weight");
  ggml_set_name(b, "embodiment.state_encoder.layer1.bias");
  std::memset(w->data, 0, ggml_nbytes(w));
  std::memset(b->data, 0, ggml_nbytes(b));

  struct gguf_context* g = gguf_init_empty();
  if (g == nullptr) {
    ggml_free(ctx);
    throw std::runtime_error("gguf_init_empty failed");
  }
  gguf_set_val_str(g, "general.architecture", "groot");
  gguf_set_val_str(g, "groot.embodiment_tag", "libero_sim");
  gguf_set_val_u32(g, "groot.embodiment_cat_id", 2);
  addKeys(g);
  gguf_add_tensor(g, w);
  gguf_add_tensor(g, b);
  const std::string path = std::string(::testing::TempDir()) + name;
  const bool ok = gguf_write_to_file(g, path.c_str(), /*only_meta=*/false);
  gguf_free(g);
  ggml_free(ctx);
  if (!ok) {
    throw std::runtime_error("gguf_write_to_file failed for " + path);
  }
  return path;
}

// Returns the rejection message, or "" if the load unexpectedly succeeded. The
// message MATTERS: a metadata-only GGUF would also be rejected for having no
// tensors, so asserting only that something threw would pass without ever
// reaching the check under test.
std::string loadMetaOnlyError(const std::string& path) {
  try {
    qvac_lib_infer_vla_ggml::createVlaModelFromGguf(
        path, /*forceCpu=*/true, /*backendsDir=*/"", VlaEmbodimentRequest{});
  } catch (const std::exception& e) {
    return e.what();
  }
  return "";
}

} // namespace

TEST(GrootLoadCorruptMetadata, CountDisagreeingWithTableIsRejected) {
  const std::vector<int32_t> stored = {2, 24, 25};
  const std::string path =
      writeMetaOnlyGguf("groot_count_mismatch.gguf", [&](gguf_context* g) {
        gguf_set_arr_data(
            g,
            "groot.embodiment.stored_cat_ids",
            GGUF_TYPE_INT32,
            stored.data(),
            stored.size());
        // Claims 4 rows while the table holds 3.
        gguf_set_val_u32(g, "groot.embodiment.count", 4);
      });
  const std::string err = loadMetaOnlyError(path);
  std::remove(path.c_str());
  EXPECT_NE(err.find("grootCheckEmbodimentCount"), std::string::npos)
      << "expected the count cross-check to reject this file, got: " << err;
}

TEST(GrootLoadCorruptMetadata, WronglyTypedShipSetTableIsRejected) {
  const std::vector<uint32_t> wrongType = {2, 24, 25};
  const std::string path =
      writeMetaOnlyGguf("groot_bad_table_type.gguf", [&](gguf_context* g) {
        gguf_set_arr_data(
            g,
            "groot.embodiment.stored_cat_ids",
            GGUF_TYPE_UINT32,
            wrongType.data(),
            wrongType.size());
      });
  // Must NOT be silently treated as absent: the weights would still be shaped
  // for the table, and the mismatch would only surface at the first infer.
  const std::string err = loadMetaOnlyError(path);
  std::remove(path.c_str());
  EXPECT_NE(err.find("is not an int32 array"), std::string::npos)
      << "expected the wrong-type table to be reported as corruption, got: "
      << err;
}

// A file with no readable ship-set table whose embodiment weights nonetheless
// carry a stored bank. Without the early check this loads clean and then aborts
// the process on the first infer, inside GGML_ASSERT(ggml_can_mul_mat).
TEST(GrootLoadCorruptMetadata, RankThreeWeightsWithoutTableAreRejected) {
  const std::string path = writeGgufWithEmbodimentProbe(
      "groot_rank3_no_table.gguf", /*rows=*/3, [](gguf_context*) {
        // No stored_cat_ids at all: the resolver takes the v1 path and reports
        // row -1, while the tensors still hold 3 rows.
      });
  const std::string err = loadMetaOnlyError(path);
  std::remove(path.c_str());
  EXPECT_NE(err.find("grootCheckV1EmbodimentRank"), std::string::npos)
      << "expected the v1 rank check to reject a stored bank with no table, "
         "got: "
      << err;
}

// The table and the tensors disagree on how many rows exist. Slicing off the
// table's count would read another row's bytes, or past the tensor entirely.
TEST(GrootLoadCorruptMetadata, TableRowCountDisagreeingWithTensorsIsRejected) {
  const std::vector<int32_t> stored = {2, 24, 25};
  const std::vector<int32_t> cams = {2, 4, 4};
  const std::string path = writeGgufWithEmbodimentProbe(
      "groot_row_count_mismatch.gguf",
      // Table says 3 rows, tensors carry 2.
      /*rows=*/2,
      [&](gguf_context* g) {
        gguf_set_arr_data(
            g,
            "groot.embodiment.stored_cat_ids",
            GGUF_TYPE_INT32,
            stored.data(),
            stored.size());
        // Present so the default row's camera count is known and the resolver
        // gets as far as selecting a row.
        gguf_set_arr_data(
            g,
            "groot.embodiment.stored_num_cameras",
            GGUF_TYPE_INT32,
            cams.data(),
            cams.size());
      });
  const std::string err = loadMetaOnlyError(path);
  std::remove(path.c_str());
  EXPECT_NE(err.find("GGUF metadata/tensor mismatch"), std::string::npos)
      << "expected the slice-shape check to reject the row-count disagreement, "
         "got: "
      << err;
}

// Corrupt GGUF metadata, built in memory: no file, no fixture. A ship-set table
// written with the wrong array element type must be reported rather than
// treated as absent, because the tensors are still shaped for it.
TEST(GgufGetI32ArrOr, PresentButWrongTypeThrows) {
  struct gguf_context* g = gguf_init_empty();
  ASSERT_NE(g, nullptr);
  const std::vector<int32_t> good = {2, 24, 25};
  const std::vector<uint32_t> wrongType = {2, 24, 25};
  gguf_set_arr_data(
      g,
      "groot.embodiment.stored_cat_ids",
      GGUF_TYPE_INT32,
      good.data(),
      good.size());
  gguf_set_arr_data(
      g,
      "groot.embodiment.bad_type",
      GGUF_TYPE_UINT32,
      wrongType.data(),
      wrongType.size());
  gguf_set_val_u32(g, "groot.embodiment.not_an_array", 3);

  EXPECT_EQ(
      ggufGetI32ArrOr(g, "groot.embodiment.stored_cat_ids", {}),
      std::vector<int>({2, 24, 25}));
  // Absent stays a silent default: that is a legitimate v1 GGUF.
  EXPECT_EQ(
      ggufGetI32ArrOr(g, "groot.embodiment.absent", {7}),
      std::vector<int>({7}));
  EXPECT_THROW(
      ggufGetI32ArrOr(g, "groot.embodiment.bad_type", {}), std::runtime_error);
  EXPECT_THROW(
      ggufGetI32ArrOr(g, "groot.embodiment.not_an_array", {}),
      std::runtime_error);
  gguf_free(g);
}
