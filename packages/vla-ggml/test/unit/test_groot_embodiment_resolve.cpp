// Multi-embodiment load-time selection — grootResolveEmbodiment unit tests.
// The resolver is the pure table -> row + num_cameras logic pulled out of
// grootLoadModel; testing it directly exercises the load-time override and all
// its error paths without a multi-GB model load. No GGUF, no ggml.

#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/groot.hpp"

using qvac_lib_infer_vla_ggml::grootCheckEmbodimentSliceShape;
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
