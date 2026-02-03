declare module "bare-zlib" {
  import type { Transform } from "stream";

  export function createGunzip(): Transform;
  export function createGzip(): Transform;
  export function createInflate(): Transform;
  export function createDeflate(): Transform;
  export function createInflateRaw(): Transform;
  export function createDeflateRaw(): Transform;
}
