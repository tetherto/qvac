'use strict'

// Shared GGUF registry metadata.
//
// Used by both:
//   - scripts/download-models.js   (Node CLI -- desktop CI pre-stage).
//   - test/utils/downloadModel.js  (Bare runtime fallback inside the
//                                   integration suite, including the
//                                   mobile test framework's bundled
//                                   copy under backend/test/utils/).
//
// Lives under test/utils/ (rather than scripts/) so the mobile test
// framework's "copy test/ into backend/" packing path picks it up
// automatically -- the framework does not copy scripts/, which broke
// the mobile integration build the first time this file lived there.
//
// Keeping the two consumers in sync was the original failure mode: a
// quant flip landed in the test-time fetcher but not in the converter
// / mobile asset pipeline.  One source of truth removes the drift.
//
// Mobile integration tests prefer the q4_0 quantised variants where
// available to stay under Android's per-app memory budget (the S23 FE
// triggered lmkd SIGKILL with the full-precision 1.8 GB Chatterbox
// pair; q4_0 t3 + f16 s3gen drops peak RSS by ~600 MB).
//
//   - chatterbox-t3-turbo / -t3-mtl / supertonic / supertonic2:
//     q4_0 + q8_0 published under
//     qvac_models_compiled/ggml/<engine>/2026-05-18/.
//   - chatterbox-s3gen / -s3gen-mtl: only f16 exists under
//     qvac_models_compiled/chatterbox/2026-05-08/ (the vocoder /
//     HiFT side hasn't been quantised yet; once it lands, point the
//     entry below at the q4_0 path and drop the f16 fallback).
//
// On-disk filenames stay at the historical `<name>.gguf` shape so the
// TTSGgml index.js resolver finds them without changing its hard-coded
// lookups.  tts-cpp reads the quant from the GGUF metadata at load
// time, not from the filename, so flipping registryPath is enough.

const REGISTRY_SOURCE = 's3'
const REGISTRY_DATE_F16 = '2026-05-08'
const REGISTRY_DATE_Q4_0 = '2026-05-18'

// Size bands.  Both bounds are enforced so a stale f16 cache from a
// previous test run gets rejected and re-fetched at the quantised
// size.  Numbers are deliberately generous: ~50% headroom on each side
// of the actual on-registry size to absorb future re-quantisation
// passes without needing a code change here.
const SIZE_CHATTERBOX_T3_Q4_0 = { minSize: 100_000_000, maxSize: 500_000_000 }
const SIZE_CHATTERBOX_S3GEN_F16 = { minSize: 500_000_000, maxSize: 2_000_000_000 }
const SIZE_SUPERTONIC_Q4_0 = { minSize: 25_000_000, maxSize: 250_000_000 }
const SIZE_SUPERTONIC2_Q4_0 = { minSize: 25_000_000, maxSize: 250_000_000 }

const CHATTERBOX_GGUFS = [
  {
    name: 'chatterbox-t3-turbo.gguf',
    ...SIZE_CHATTERBOX_T3_Q4_0,
    registryPath: `qvac_models_compiled/ggml/chatterbox/${REGISTRY_DATE_Q4_0}/chatterbox-t3-turbo-q4_0.gguf`,
    registrySource: REGISTRY_SOURCE
  },
  {
    name: 'chatterbox-s3gen.gguf',
    ...SIZE_CHATTERBOX_S3GEN_F16,
    registryPath: `qvac_models_compiled/chatterbox/${REGISTRY_DATE_F16}/chatterbox-s3gen.gguf`,
    registrySource: REGISTRY_SOURCE
  }
]

const CHATTERBOX_MTL_GGUFS = [
  {
    name: 'chatterbox-t3-mtl.gguf',
    ...SIZE_CHATTERBOX_T3_Q4_0,
    registryPath: `qvac_models_compiled/ggml/chatterbox/${REGISTRY_DATE_Q4_0}/chatterbox-t3-mtl-q4_0.gguf`,
    registrySource: REGISTRY_SOURCE
  },
  {
    name: 'chatterbox-s3gen-mtl.gguf',
    ...SIZE_CHATTERBOX_S3GEN_F16,
    registryPath: `qvac_models_compiled/chatterbox/${REGISTRY_DATE_F16}/chatterbox-s3gen-mtl.gguf`,
    registrySource: REGISTRY_SOURCE
  }
]

const SUPERTONIC_GGUFS = [
  {
    name: 'supertonic.gguf',
    ...SIZE_SUPERTONIC_Q4_0,
    registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_Q4_0}/supertonic-q4_0.gguf`,
    registrySource: REGISTRY_SOURCE
  }
]

const SUPERTONIC_MTL_GGUFS = [
  {
    name: 'supertonic2.gguf',
    ...SIZE_SUPERTONIC2_Q4_0,
    registryPath: `qvac_models_compiled/ggml/supertonic/${REGISTRY_DATE_Q4_0}/supertonic2-q4_0.gguf`,
    registrySource: REGISTRY_SOURCE
  }
]

const GROUPS = {
  chatterbox: CHATTERBOX_GGUFS,
  'chatterbox-mtl': CHATTERBOX_MTL_GGUFS,
  supertonic: SUPERTONIC_GGUFS,
  'supertonic-mtl': SUPERTONIC_MTL_GGUFS
}

const ALL_GROUP_NAMES = Object.keys(GROUPS)

function allGgufs () {
  const seen = new Set()
  const out = []
  for (const name of ALL_GROUP_NAMES) {
    for (const f of GROUPS[name]) {
      if (seen.has(f.name)) continue
      seen.add(f.name)
      out.push(f)
    }
  }
  return out
}

function getGroup (groupName) {
  if (groupName === 'all') return allGgufs()
  const group = GROUPS[groupName]
  if (!group) {
    throw new Error(`Unknown GGUF group: ${groupName}. Available: all, ${ALL_GROUP_NAMES.join(', ')}`)
  }
  return group
}

module.exports = {
  REGISTRY_SOURCE,
  CHATTERBOX_GGUFS,
  CHATTERBOX_MTL_GGUFS,
  SUPERTONIC_GGUFS,
  SUPERTONIC_MTL_GGUFS,
  GROUPS,
  ALL_GROUP_NAMES,
  allGgufs,
  getGroup
}
