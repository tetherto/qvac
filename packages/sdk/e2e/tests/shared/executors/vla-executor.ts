import { vla, vlaHparams, vlaPadState, vlaPreprocessImage, vlaSetEmbodiment } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { vlaTests } from '../../vla-tests.js'

interface VlaParams {
  inputs?: 'synthetic' | 'synthetic-wrong-img-size'
  switchCatId?: number
  switchNumCameras?: number
}

interface HparamsShape {
  chunkSize: number
  actionDim: number
  maxActionDim: number
  maxStateDim: number
  tokenizerMaxLength: number
  visionImageSize: number
  numCameras?: number
  stateInputMode?: 'continuous' | 'discrete'
  imageInputMode?: 'pixels' | 'patches'
  imagePatchElems?: number
  selectedEmbodimentTag?: string
  selectedEmbodimentCatId?: number
}

// GR00T patch-input layout. GR00T reports `tokenizerMaxLength: 0` — the prompt
// length follows the image count, not a hparam: one run of 64 merged image
// tokens (256 patches, 2×2 merge) plus a text separator per camera, then a
// ~20-token text tail (mirrors the addon's own multi-camera prompt builder, so
// it holds for any embodiment's camera count, not just LIBERO's 2). The
// Qwen3-VL image placeholder id is 151655.
const GROOT_IMAGE_TOKEN_ID = 151655
const GROOT_MERGED_TOKENS_PER_IMAGE = 64
const GROOT_PROMPT_TEXT_TAIL = 20

// pi05 tests bind to the `vla-pi05` resource, GR00T to `vla-groot` /
// `vla-groot-multi`, SmolVLA to `vla`. The resource is derived from the testId
// so a single executor drives all. The multi check must precede the plain
// groot one — `vla-groot-multi-` also matches the `vla-groot-` prefix.
function depForTest(testId: string): string {
  if (testId.startsWith('vla-pi05-')) return 'vla-pi05'
  if (testId.startsWith('vla-groot-multi-')) return 'vla-groot-multi'
  if (testId.startsWith('vla-groot-')) return 'vla-groot'
  return 'vla'
}

export class VlaExecutor extends AbstractModelExecutor<typeof vlaTests> {
  pattern = /^vla-/

  protected handlers = Object.fromEntries(
    vlaTests.map((test) => {
      const dep = depForTest(test.testId)
      if (/-hparams-shape$/.test(test.testId)) {
        return [test.testId, this.runHparams.bind(this, dep)]
      }
      if (/-invalid-img-size$/.test(test.testId)) {
        return [test.testId, this.runInvalidImgSize.bind(this, dep)]
      }
      if (/-set-embodiment$/.test(test.testId)) {
        return [test.testId, this.runSetEmbodiment.bind(this, dep)]
      }
      return [test.testId, this.runSyntheticInference.bind(this, dep)]
    })
  ) as never

  private async ensureModel(dep: string) {
    return this.resources.ensureLoaded(dep)
  }

  // Build synthetic inputs sized to whatever the loaded model reports. Reads
  // `numCameras` (2 for SmolVLA, 3 for π₀.₅) and `stateInputMode` so the same
  // path drives both architectures:
  //   - continuous (SmolVLA): zero-padded state of length maxStateDim.
  //   - discrete (π₀.₅): empty state (it's tokenised into the prompt) + the
  //     required noise prior.
  private buildSyntheticInputs(hp: HparamsShape) {
    const size = hp.visionImageSize
    const numCameras = hp.numCameras ?? 2

    // GR00T (patch-input): each camera is a pre-patchified buffer of
    // `imagePatchElems` floats, continuous state, required noise, and a prompt
    // with one run of merged image tokens per camera.
    if (hp.imageInputMode === 'patches') {
      const patchElems = hp.imagePatchElems ?? 0
      const images = Array.from({ length: numCameras }, () =>
        new Float32Array(patchElems).fill(0.02)
      )
      // Prompt length follows the camera count (a 4-camera embodiment needs
      // 4 image-token runs, which LIBERO's fixed 148 cannot hold).
      const promptLength = numCameras * (GROOT_MERGED_TOKENS_PER_IMAGE + 1) + GROOT_PROMPT_TEXT_TAIL
      const tokens = new Int32Array(promptLength)
      let w = 0
      for (let cam = 0; cam < numCameras; cam++) {
        for (let k = 0; k < GROOT_MERGED_TOKENS_PER_IMAGE && w < tokens.length; k++) {
          tokens[w++] = GROOT_IMAGE_TOKEN_ID
        }
        if (w < tokens.length) tokens[w++] = 1000 + cam
      }
      for (; w < tokens.length; w++) tokens[w] = 1000 + w
      const mask = new Uint8Array(promptLength).fill(1)
      return {
        images,
        imgWidth: size,
        imgHeight: size,
        state: vlaPadState([0, 0, 0, 0, 0, 0], hp.maxStateDim),
        tokens,
        mask,
        noise: new Float32Array(hp.chunkSize * hp.maxActionDim)
      }
    }

    const dummyPixels = new Uint8Array(size * size * 3).fill(128)
    const images = Array.from({ length: numCameras }, () =>
      vlaPreprocessImage(dummyPixels, size, size, { size })
    )
    const tokens = new Int32Array(hp.tokenizerMaxLength)
    const mask = new Uint8Array(hp.tokenizerMaxLength)
    // BOS-only "instruction" — exercises the full prefill path without
    // depending on a tokenizer at test time.
    tokens[0] = 1
    mask[0] = 1
    const state =
      hp.stateInputMode === 'discrete'
        ? new Float32Array(0)
        : vlaPadState([0, 0, 0, 0, 0, 0], hp.maxStateDim)
    const noise = new Float32Array(hp.chunkSize * hp.maxActionDim)
    return {
      images,
      imgWidth: size,
      imgHeight: size,
      state,
      tokens,
      mask,
      noise
    }
  }

  async runHparams(dep: string, _params: VlaParams, expectation: Expectation): Promise<TestResult> {
    try {
      const modelId = await this.ensureModel(dep)
      const result = await vlaHparams({ modelId })
      return ValidationHelpers.validate(result, expectation)
    } catch (error) {
      return {
        passed: false,
        output: `vlaHparams failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  async runSyntheticInference(
    dep: string,
    _params: VlaParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureModel(dep)
      const { hparams } = await vlaHparams({ modelId })
      const inputs = this.buildSyntheticInputs(hparams)
      const { actions, actionDim, chunkSize, stats } = await vla({
        modelId,
        ...inputs
      })
      // Surface a flat result shape to the test's `fn` so the assertions
      // in vla-tests.ts can stay framework-agnostic.
      return ValidationHelpers.validate(
        {
          actionsLength: actions.length,
          expectedLength: chunkSize * actionDim,
          actionDim,
          chunkSize,
          numImages: inputs.images.length,
          stateLength: inputs.state.length,
          stats
        },
        expectation
      )
    } catch (error) {
      return {
        passed: false,
        output: `vla inference failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  // Runtime embodiment switch round-trip on the multi-embodiment GR00T GGUF:
  // switch via the `{ catId, numCameras }` object selector (exercising the
  // camera-count override spelling), run with inputs rebuilt from the
  // refreshed hparams (the camera count follows the new embodiment), verify
  // an unknown tag is rejected without disturbing the active embodiment, then
  // switch back by plain cat_id — covering both selector spellings. The
  // restore runs in a finally so a throw mid-test cannot leave the shared
  // vla-groot-multi resource on the switched embodiment for later tests.
  async runSetEmbodiment(
    dep: string,
    params: VlaParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureModel(dep)
      const { hparams: initial } = await vlaHparams({ modelId })
      const initialCatId = (initial as HparamsShape).selectedEmbodimentCatId
      const switchCatId = params.switchCatId ?? 24
      const switchNumCameras = params.switchNumCameras

      let sw: HparamsShape | undefined
      let ranOnSwitched = false
      let unknownTagRejected = false
      let activeCatIdAfterReject: number | undefined
      let restoredCatId: number | undefined
      try {
        const { hparams: switched } = await vlaSetEmbodiment({
          modelId,
          embodiment:
            switchNumCameras !== undefined
              ? { catId: switchCatId, numCameras: switchNumCameras }
              : switchCatId
        })
        sw = switched as HparamsShape

        const inputs = this.buildSyntheticInputs(sw)
        const { actions } = await vla({ modelId, ...inputs })
        ranOnSwitched = actions.length === sw.chunkSize * sw.actionDim

        try {
          await vlaSetEmbodiment({ modelId, embodiment: 'qvac_e2e_no_such_embodiment' })
        } catch {
          unknownTagRejected = true
        }
        const { hparams: afterReject } = await vlaHparams({ modelId })
        activeCatIdAfterReject = (afterReject as HparamsShape).selectedEmbodimentCatId
      } finally {
        try {
          const { hparams: restored } = await vlaSetEmbodiment({
            modelId,
            embodiment: initialCatId ?? 0
          })
          restoredCatId = (restored as HparamsShape).selectedEmbodimentCatId
        } catch {
          // Leave restoredCatId undefined — the expectation's restore check
          // fails visibly rather than masking the original error.
        }
      }

      return ValidationHelpers.validate(
        {
          initialCatId,
          switchedCatId: sw?.selectedEmbodimentCatId,
          switchedTag: sw?.selectedEmbodimentTag,
          switchedNumCameras: sw?.numCameras,
          ranOnSwitched,
          unknownTagRejected,
          activeCatIdAfterReject,
          restoredCatId
        },
        expectation
      )
    } catch (error) {
      return {
        passed: false,
        output: `vla set-embodiment test failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  async runInvalidImgSize(
    dep: string,
    _params: VlaParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureModel(dep)
      const { hparams } = await vlaHparams({ modelId })
      const size = hparams.visionImageSize
      const wrongSize = size === 256 ? 512 : 256
      const numCameras = hparams.numCameras ?? 2

      // Build inputs whose pixel buffers ARE consistent with the (wrong)
      // imgWidth/imgHeight so we don't trip the earlier
      // "pixel.length === 3*imgW*imgH" check. Only imgWidth !=
      // hparams.visionImageSize is wrong here.
      const dummyPixels = new Float32Array(3 * wrongSize * wrongSize)
      const images = Array.from({ length: numCameras }, () => dummyPixels)
      const tokens = new Int32Array(hparams.tokenizerMaxLength)
      const mask = new Uint8Array(hparams.tokenizerMaxLength)
      tokens[0] = 1
      mask[0] = 1
      const state =
        hparams.stateInputMode === 'discrete'
          ? new Float32Array(0)
          : vlaPadState([0, 0, 0, 0, 0, 0], hparams.maxStateDim)
      const noise = new Float32Array(hparams.chunkSize * hparams.maxActionDim)
      const badInputs = {
        images,
        imgWidth: wrongSize,
        imgHeight: wrongSize,
        state,
        tokens,
        mask,
        noise
      }

      let rejected = false
      let errorMsg = ''
      try {
        await vla({ modelId, ...badInputs })
      } catch (e) {
        rejected = true
        errorMsg = e instanceof Error ? e.message : String(e)
      }

      // After the rejection, a fresh canonical-shape run() must succeed —
      // proves `_hasActiveResponse` was cleared (no wedge from QVAC-VLA
      // PR #1784 review). Mirrors the addon's own integration assertion.
      let recoveryRan = false
      try {
        const inputs = this.buildSyntheticInputs(hparams)
        const { actions } = await vla({ modelId, ...inputs })
        recoveryRan = actions.length === hparams.chunkSize * hparams.actionDim
      } catch {
        recoveryRan = false
      }

      return ValidationHelpers.validate({ rejected, recoveryRan, errorMsg }, expectation)
    } catch (error) {
      return {
        passed: false,
        output: `vla invalid-img-size test failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}
