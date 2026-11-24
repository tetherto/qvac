import {
  loadModel,
  estimateDisparity,
  ModelType,
  PLUGIN_STEREO_DEPTH,
  type DisparityMap,
  type StereoDepthConfig
} from '../src/index'

const config: StereoDepthConfig = { backend: 'CPU', threads: 4 }
void loadModel({
  modelType: ModelType.ggmlStereoDepth,
  modelSrc: '/models/bridgedepth-vits-f32.gguf',
  modelConfig: config
})
void loadModel({
  modelSrc: { src: '/models/bridgedepth-vits-f32.gguf', engine: ModelType.ggmlStereoDepth },
  modelConfig: config
})
const call = estimateDisparity({
  modelId: 'm',
  left: new Uint8Array([1]),
  right: new Uint8Array([2])
})
const requestId: string = call.requestId
void requestId
void call.then((map: DisparityMap) => {
  const values: Float32Array = map.disparity
  void values
})
const plugin: '@qvac/sdk/ggml-stereo-depth/plugin' = PLUGIN_STEREO_DEPTH
void plugin
// @ts-expect-error BridgeDepth weights must have an explicit source.
void loadModel({ modelType: ModelType.ggmlStereoDepth })
const classifierConfig: StereoDepthConfig = {
  // @ts-expect-error Stereo depth config does not accept classification options.
  topK: 3
}
void classifierConfig
// @ts-expect-error The client takes both views as bytes.
void estimateDisparity({ modelId: 'm', left: 'AQID', right: new Uint8Array([2]) })
// @ts-expect-error Both views are required.
void estimateDisparity({ modelId: 'm', left: new Uint8Array([1]) })
