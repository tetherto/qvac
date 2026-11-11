import { BridgeDepth, type DisparityResult, type StereoImageOptions } from "../../index";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type Infer = Assert<Equal<ReturnType<BridgeDepth["infer"]>, Promise<DisparityResult>>>;
export type InferOptions = Assert<Equal<Parameters<BridgeDepth["infer"]>[2], StereoImageOptions | undefined>>;
export type Disparity = Assert<Equal<DisparityResult["disparity"], Float32Array>>;
export type Load = Assert<Equal<ReturnType<BridgeDepth["load"]>, Promise<void>>>;
export type Unload = Assert<Equal<ReturnType<BridgeDepth["unload"]>, Promise<void>>>;
export type Destroy = Assert<Equal<ReturnType<BridgeDepth["destroy"]>, Promise<void>>>;
