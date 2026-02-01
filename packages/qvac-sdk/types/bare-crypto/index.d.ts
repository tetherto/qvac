declare module "bare-crypto" {
  import type { Transform } from "stream";

  export interface Hash extends Transform {
    update(data: string | Buffer): Hash;
    digest(encoding?: "hex" | "binary" | "base64"): string | Buffer;
  }

  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Buffer;
  export function createCipher(
    algorithm: string,
    password: string | Buffer,
  ): Transform;
  export function createDecipher(
    algorithm: string,
    password: string | Buffer,
  ): Transform;
  export function createHmac(
    algorithm: string,
    key: string | Buffer,
  ): Transform;
  export function pbkdf2(
    password: string | Buffer,
    salt: string | Buffer,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (err: Error | null, derivedKey: Buffer) => void,
  ): void;
  export function pbkdf2Sync(
    password: string | Buffer,
    salt: string | Buffer,
    iterations: number,
    keylen: number,
    digest: string,
  ): Buffer;
}
