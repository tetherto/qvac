import fs from "bare-fs";
import crypto from "bare-crypto";
import { nowMs } from "@/profiling";
import type { DownloadHooks } from "@/server/rpc/handlers/load-model/types";
import { type Buffer } from "bare-buffer";

export async function calculateFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash("sha-256");
      const stream = fs.createReadStream(filePath);

      stream.on("data", (chunk: Buffer) => {
        hash.update(chunk);
      });

      stream.on("end", () => {
        resolve(hash.digest("hex"));
      });

      stream.on("error", (error: Error) => {
        reject(new Error(`Checksum calculation error: ${error.message}`));
      });
    } catch (error) {
      reject(
        error instanceof Error
          ? error
          : new Error(`Checksum calculation error: ${String(error)}`),
      );
    }
  });
}

export async function measureChecksum(
  filePath: string,
  hooks?: DownloadHooks,
): Promise<string> {
  const start = nowMs();
  const checksum = await calculateFileChecksum(filePath);
  hooks?.addChecksumValidationTimeMs?.(nowMs() - start);
  return checksum;
}
