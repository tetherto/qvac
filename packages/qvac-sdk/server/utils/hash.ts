import crypto from "bare-crypto";

/**
 * Generate a short hash (16 characters) from any input string
 */
export function generateShortHash(input: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.from(input, "utf8"))
    .digest("hex") as string;
  return hash.substring(0, 16);
}
