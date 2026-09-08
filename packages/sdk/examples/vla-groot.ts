/**
 * NVIDIA GR00T N1.7-3B (vision-language-action) example using the QVAC SDK.
 *
 * Loads the GR00T-N1.7-3B LIBERO GGUF model, runs a single inference pass with
 * synthetic inputs, and prints the produced action chunk + per-stage timings.
 *
 * GR00T differs from SmolVLA / π₀.₅ in the ways the SDK surfaces via
 * `vlaHparams()`:
 *   - `imageInputMode: 'patches'` — each `images` entry is a pre-patchified
 *     buffer of `hparams.imagePatchElems` floats, NOT a `3·w·h` pixel plane.
 *     A real consumer patchifies each camera frame the way `Gr00tPolicy` does
 *     (the model's learned patch-embed runs inside the addon); here we feed
 *     synthetic patch buffers of the right length.
 *   - `stateInputMode: 'continuous'` — the robot state is projected by an
 *     in-model linear layer; pad it to `hparams.maxStateDim` with `vlaPadState`.
 *   - `noise` is REQUIRED. GR00T is a flow-matching model that does not sample
 *     its own prior; a missing `noise` is rejected as INVALID_INPUT.
 *
 * The prompt must place one contiguous run of `MERGED_TOKENS_PER_IMAGE`
 * image-placeholder tokens per camera. A real consumer produces this by
 * tokenising the instruction with the Qwen3-VL tokenizer, which inserts the
 * image tokens; we lay it out by hand for the smoke.
 *
 * Usage:
 *   bun examples/vla-groot.ts [path-to-groot.gguf]
 *
 * By default the example pulls the registry-baked GR00T-LIBERO GGUF (~3.76 GB)
 * on first run and caches it locally. Pass an absolute path on the command line
 * to override and load a local GGUF instead.
 *
 * Multi-embodiment GGUFs (vla-ggml >= 0.17.0): one GGUF can carry many
 * embodiments, one active at a time. Optional env vars demonstrate selection:
 *   QVAC_GROOT_EMBODIMENT        initial selection at load — a tag
 *                                (e.g. 'libero_sim') or a numeric cat_id
 *   QVAC_GROOT_SWITCH_EMBODIMENT after load, switch via vlaSetEmbodiment()
 *                                and run inference on the new embodiment
 * Both are no-ops you can omit; the GGUF's default embodiment is used. On a
 * single-embodiment GGUF a switch is rejected by the addon.
 */
import {
  close,
  loadModel,
  GROOT_Q8_VF16,
  unloadModel,
  vla,
  vlaHparams,
  vlaSetEmbodiment,
  vlaPadState,
  type VlaEmbodimentSelection
} from '@qvac/sdk'

// LIBERO GR00T prompt layout (Qwen3-VL tokenizer). GR00T reports
// `hparams.tokenizerMaxLength === 0` — it does not surface a tokenizer length,
// so the prompt length is fixed by the model: 2 cameras × 64 merged image
// tokens (256 patches, 2×2 merge) = 128 image tokens, plus text ≈ 150 total.
// A real consumer gets these from the tokenizer; the smoke hard-codes them.
// The prompt length follows the ACTIVE embodiment's camera count (a 4-camera
// DROID row needs 4 image-token runs, which a fixed 2-camera length cannot
// hold), so it is computed per inference, not a constant.
const IMAGE_TOKEN_ID = 151655
const MERGED_TOKENS_PER_IMAGE = 64
const PROMPT_TEXT_TAIL = 20
const TEXT_TOKEN_ID = 1000

const modelSrcOverride = process.argv[2]
const modelSrc = modelSrcOverride ?? GROOT_Q8_VF16

// A tag string or a numeric cat_id, straight from the env. '24' is a cat_id,
// 'libero_sim' a tag.
function embodimentFromEnv(name: string): VlaEmbodimentSelection | undefined {
  const env = process.env as Record<string, string | undefined>
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  return /^\d+$/.test(raw) ? Number(raw) : raw
}

const embodiment = embodimentFromEnv('QVAC_GROOT_EMBODIMENT')
const switchEmbodiment = embodimentFromEnv('QVAC_GROOT_SWITCH_EMBODIMENT')

try {
  console.log('▸ Loading GR00T (N1.7-3B LIBERO) model...')
  const modelId = await loadModel({
    modelSrc,
    modelType: 'ggml-vla',
    modelConfig: { backend: 'cpu', ...(embodiment !== undefined && { embodiment }) },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
  if (typeof modelSrc !== 'string') process.stderr.write('\n')
  console.log(`▸ Model loaded: ${modelId}`)

  const { hparams, backendName } = await vlaHparams({ modelId })
  console.log(`▸ Backend: ${backendName ?? '(unknown)'}`)
  console.log('▸ Hparams:', hparams)
  if (hparams.selectedEmbodimentTag !== undefined) {
    console.log(
      `▸ Embodiment: ${hparams.selectedEmbodimentTag} ` +
        `(cat_id ${hparams.selectedEmbodimentCatId}, ${hparams.numCameras} cameras)`
    )
  }

  // Inputs are sized off the hparams, which follow the ACTIVE embodiment
  // (numCameras, actionDim, ...) — rebuild them after every embodiment switch.
  async function runInference(hp: typeof hparams) {
    const patchElems = hp.imagePatchElems
    if (hp.imageInputMode !== 'patches' || patchElems === undefined) {
      throw new Error(
        `expected a patch-input model (imageInputMode 'patches' + imagePatchElems); ` +
          `got imageInputMode=${hp.imageInputMode}`
      )
    }

    const numCameras = hp.numCameras ?? 2

    // Patch-input model: each camera is a pre-patchified buffer of exactly
    // `imagePatchElems` floats. A real consumer patchifies each camera frame the
    // way `Gr00tPolicy` does (the model's learned patch-embed runs inside the
    // addon); we use small synthetic values.
    const images = Array.from({ length: numCameras }, () => new Float32Array(patchElems).fill(0.02))

    // Continuous-state model: pad the robot state to `maxStateDim`.
    const state = vlaPadState([0, 0, 0, 0, 0, 0], hp.maxStateDim)

    // GR00T requires the noise prior (flow-matching; it is not sampled in-model).
    const noise = new Float32Array(hp.chunkSize * hp.maxActionDim)

    // Prompt: one run of `MERGED_TOKENS_PER_IMAGE` image tokens per camera,
    // each followed by a text separator, plus a short text tail. Sized off the
    // active embodiment's camera count — a fixed 2-camera length would
    // silently truncate the image-token runs of cameras 3+ after a switch to
    // e.g. the 4-camera DROID row.
    const promptLength = numCameras * (MERGED_TOKENS_PER_IMAGE + 1) + PROMPT_TEXT_TAIL
    const tokens = new Int32Array(promptLength)
    let w = 0
    for (let cam = 0; cam < numCameras; cam++) {
      for (let k = 0; k < MERGED_TOKENS_PER_IMAGE && w < tokens.length; k++) {
        tokens[w++] = IMAGE_TOKEN_ID
      }
      if (w < tokens.length) tokens[w++] = TEXT_TOKEN_ID + cam
    }
    for (; w < tokens.length; w++) tokens[w] = TEXT_TOKEN_ID + w
    const mask = new Uint8Array(promptLength).fill(1)

    console.log('▸ Running VLA inference...')
    const { actions, actionDim, chunkSize, stats } = await vla({
      modelId,
      images,
      // Patch inputs ignore imgWidth/imgHeight, but the request schema requires
      // positive integers; pass the model's vision image size.
      imgWidth: hp.visionImageSize,
      imgHeight: hp.visionImageSize,
      state,
      tokens,
      mask,
      noise
    })

    console.log(`▸ Got ${chunkSize} action steps of dim ${actionDim}.`)
    console.log(Array.from(actions.subarray(0, actionDim)))
    if (stats) {
      console.log(
        `▸ Timing: vision=${stats.vision_ms?.toFixed(0)}ms ` +
          `ode=${stats.ode_ms?.toFixed(0)}ms ` +
          `total=${stats.total_ms?.toFixed(0)}ms`
      )
    }
  }

  await runInference(hparams)

  if (switchEmbodiment !== undefined) {
    console.log(`▸ Switching embodiment to ${JSON.stringify(switchEmbodiment)}...`)
    const { hparams: refreshed } = await vlaSetEmbodiment({ modelId, embodiment: switchEmbodiment })
    console.log(
      `▸ Embodiment: ${refreshed.selectedEmbodimentTag} ` +
        `(cat_id ${refreshed.selectedEmbodimentCatId}, ${refreshed.numCameras} cameras)`
    )
    await runInference(refreshed)
  }

  await unloadModel({ modelId, clearStorage: false })
  console.log('▸ Model unloaded.')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  await close()
  process.exit(1)
}
