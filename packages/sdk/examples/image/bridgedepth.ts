/**
 * Estimate stereo disparity from a rectified left/right pair with BridgeDepth.
 *
 * BridgeDepth is not in the model registry yet, so pass the path to a converted
 * GGUF (`bridgedepth-vits-f32.gguf`). Add the rig's focal length in pixels and
 * baseline in metres to also print the depth at the image centre.
 */
import { readFile } from 'node:fs/promises'
import { loadModel, estimateDisparity, unloadModel, close, ModelType } from '@qvac/sdk'

const usage =
  'Usage: bridgedepth <bridgedepth-vits-f32.gguf> <left.png> <right.png> [focalPx baselineMeters]'

let modelId: string | undefined
try {
  const [modelPath, leftPath, rightPath, focalArg, baselineArg] = process.argv.slice(2)
  if (!modelPath || !leftPath || !rightPath) throw new Error(usage)
  const focalPx = focalArg === undefined ? undefined : Number(focalArg)
  const baseline = baselineArg === undefined ? undefined : Number(baselineArg)
  const calibration = [focalPx, baseline].filter((value) => value !== undefined)
  if (calibration.length === 1 || calibration.some((value) => !(value! > 0))) {
    throw new Error(usage)
  }

  console.log('▸ Loading BridgeDepth')
  modelId = await loadModel({ modelSrc: modelPath, modelType: ModelType.ggmlStereoDepth })

  console.log('▸ Estimating disparity')
  const { width, height, disparity, stats } = await estimateDisparity({
    modelId,
    left: await readFile(leftPath),
    right: await readFile(rightPath)
  })

  const sorted = Float32Array.from(disparity).sort()
  const centre = disparity[(height >> 1) * width + (width >> 1)]!
  const result: Record<string, unknown> = {
    width,
    height,
    disparityPx: {
      min: sorted[0],
      median: sorted[sorted.length >> 1],
      max: sorted[sorted.length - 1],
      centre
    },
    stats
  }
  if (focalPx !== undefined && baseline !== undefined) {
    result['centreDepthMeters'] = centre > 0 ? (focalPx * baseline) / centre : null
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error('✖', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  try {
    if (modelId) await unloadModel({ modelId })
  } finally {
    await close()
  }
}
