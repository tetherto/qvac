import type { ErrorCodesMap } from "@qvac/error";

declare module "@qvac/error" {
  interface PackageJson {
    name?: string;
    version?: string;
    [key: string]: unknown;
  }

  export function addCodes(
    codes: ErrorCodesMap,
    packageJson?: PackageJson,
  ): void;
}
