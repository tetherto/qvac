import fs from "bare-fs";
import crypto from "bare-crypto";

export async function calculateFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);

      stream.on("data", (chunk: Buffer) => {
        hash.update(chunk);
      });

      stream.on("end", () => {
        resolve(hash.digest("hex") as string);
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
