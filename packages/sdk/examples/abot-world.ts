import {
  cancel,
  loadModel,
  unloadModel,
  worldCreateScene,
  worldStep,
  ABOT_WORLD_0_5B_Q8_0,
  ABOT_WORLD_0_5B_LF_VAE,
  ABOT_WORLD_0_5B_LF_VAE_F16,
  UMT5_XXL_ENC_Q8_0
} from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

// ABot-World: build a world from a single image, then walk it. Each step
// generates one block of video under the keys held for it and streams the
// decoded frames.
//
// Runs on the machine hosting the worker; there is no remote route. The
// default 832x480 tier needs >= 20 GB free VRAM on a dedicated GPU (24 GB card
// in practice); pass 448 256 to use the low-VRAM tier, which runs on ~6 GB
// cards well below interactive frame rates.
const firstFramePath = process.argv[2]
const prompt =
  process.argv[3] || '| unknown | A realistic outdoor world scene with a navigable path.'
const outputDir = process.argv[4] || '.'
const blocks = Number(process.argv[5] || 8)
const width = Number(process.argv[6] || 832)
const height = Number(process.argv[7] || 480)

if (!firstFramePath) {
  console.error('✖ first frame image path is required')
  console.error(
    'Usage: bun run bare:example dist/examples/abot-world.js ' +
      '<firstFrameImage> [prompt] [outputDir] [blocks] [width] [height]'
  )
  process.exit(1)
}

// A scripted walk: forward, forward while looking right, forward, idle. `keys`
// also accepts a key-state object ({ W: true }) or a raw 8-bit mask, so a live
// keyboard handler can pass its state straight through.
const TAPE: string[][] = [['W'], ['W', 'L'], ['W'], []]

try {
  console.log('▸ Loading ABot-World session (DiT + taehv + scene encoders)...')
  const modelId = await loadModel({
    modelSrc: ABOT_WORLD_0_5B_Q8_0,
    modelType: 'sdcpp-generation',
    modelConfig: {
      mode: 'world',
      // Two different VAEs, and the names are close enough to swap by accident:
      //   taehvModelSrc — taew2_2, the tiny STREAMING decoder. Turns each block's
      //     latents into pixels during the walk. Used by every worldStep.
      //   vaeModelSrc   — the full-precision Wan2.2 VAE. ENCODES the first frame
      //     during worldCreateScene, and is not touched again after that.
      // Swapping them loads at first and fails once the walk starts.
      taehvModelSrc: ABOT_WORLD_0_5B_LF_VAE,
      t5XxlModelSrc: UMT5_XXL_ENC_Q8_0,
      vaeModelSrc: ABOT_WORLD_0_5B_LF_VAE_F16,
      world: {
        seed: 42,
        // ~3.7x fewer frame-passes per block. Without it, block times ramp from
        // ~1.8 s to ~7.5 s as the recompute window fills.
        kvCache: true,
        // JPEG rather than PNG: a block is ~14 MB of raw pixels, and this
        // example writes every frame to disk.
        frameJpegQuality: 85
      }
    }
  })

  console.log('▸ Creating the world (umT5 prompt encode + Wan2.2 VAE first-frame encode)...')
  const creation = worldCreateScene({
    modelId,
    prompt,
    image: new Uint8Array(fs.readFileSync(firstFramePath)),
    width,
    height,
    // The world is live on the session without this; ask for the bytes only
    // because this example saves them to walk the same world again later.
    returnPack: true
  })
  const scene = await creation.scene
  const sceneStats = await creation.stats
  const scenePath = path.join(outputDir, 'world.safetensors')
  fs.writeFileSync(scenePath, scene)
  console.log(
    `  scene pack written to ${scenePath} (${scene.length} bytes, ${sceneStats?.sceneCreateMs ?? '?'} ms)`
  )
  console.log('  reuse it later with modelConfig.sceneSrc to walk this same world again')

  console.log(`▸ Walking ${blocks} blocks...`)
  let frameNumber = 0
  for (let block = 0; block < blocks; block++) {
    const keys = TAPE[block % TAPE.length]!
    // One block at a time: a second step while this one streams is rejected,
    // so drive the next call off this one rather than firing them in parallel.
    const run = worldStep({ modelId, keys })

    for await (const frame of run.frameStream) {
      const framePath = path.join(outputDir, `frame-${String(frameNumber++).padStart(4, '0')}.jpg`)
      fs.writeFileSync(framePath, frame)
    }

    const stats = await run.stats
    console.log(
      `  block ${block + 1}/${blocks} [${keys.join('+') || 'idle'}] — ` +
        `${stats?.frames ?? '?'} frames in ${stats?.stepMs ?? '?'} ms`
    )
  }

  console.log(`✔ Wrote ${frameNumber} frames to ${outputDir}`)

  // Targeted cancellation. Cancel is block-granular: the engine has no
  // mid-block abort, so the current block finishes internally, delivery stops,
  // and the step rejects rather than returning a truncated block. A cancel that
  // lands after the block already finished legitimately succeeds instead — both
  // outcomes are correct, so handle each.
  console.log('▸ Cancelling a block mid-flight to show the contract...')
  const cancelling = worldStep({ modelId, keys: ['W'] })
  // The timer can fire after the block already finished, and cancelling a
  // request that is no longer in flight rejects. Handle it here rather than
  // leaving a floating promise: an unhandled rejection from a fire-and-forget
  // cancel would take the whole example down for the race it is demonstrating.
  const cancelTimer = setTimeout(() => {
    cancel({ requestId: cancelling.requestId }).catch(() => {
      // The block won the race; the await below reports that outcome.
    })
  }, 200)
  try {
    await cancelling.frames
    console.log('  the block completed before the cancel landed (the tolerated race)')
  } catch (error) {
    console.log(
      `  cancelled as expected: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    clearTimeout(cancelTimer)
  }

  // A cancelled step is terminal for the native session, but the SDK drops it
  // for you: another worldStep on this same modelId would transparently rebuild
  // from the promoted pack, with no unloadModel/loadModel cycle. Unloading here
  // only because the example is finished.
  await unloadModel({ modelId })
} catch (error) {
  console.error('✖ World walk failed:', error instanceof Error ? error.message : error)
  process.exit(1)
}

process.exit(0)
