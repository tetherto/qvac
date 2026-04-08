import process from "bare-process";

if (typeof globalThis.process === "undefined") {
  (globalThis as unknown as { process: typeof process }).process = process;
}
