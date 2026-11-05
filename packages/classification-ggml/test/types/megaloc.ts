import { MegaLoc } from "../../index";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type Embed = Assert<Equal<ReturnType<MegaLoc["embed"]>, Promise<Float32Array>>>;
export type Load = Assert<Equal<ReturnType<MegaLoc["load"]>, Promise<void>>>;
export type Unload = Assert<Equal<ReturnType<MegaLoc["unload"]>, Promise<void>>>;
export type Destroy = Assert<Equal<ReturnType<MegaLoc["destroy"]>, Promise<void>>>;
