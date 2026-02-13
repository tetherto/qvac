import { z } from "zod";

/**
 * Zod refinement for path components that get joined to a base directory.
 * Rejects strings containing traversal sequences (.., null bytes).
 *
 * DO NOT apply to fields that accept absolute user paths (audio/image file
 * paths, model paths, attachment paths, eSpeak data paths, etc.).
 */
export const safePathComponent = z.string().refine(
  (s) => {
    // Reject literal traversal
    if (s.includes("..")) return false;
    // Reject null bytes (literal and URL-encoded)
    if (s.includes("\0") || s.toLowerCase().includes("%00")) return false;
    // Reject URL-encoded traversal (%2e = ".", %2f = "/", %5c = "\")
    if (/%2e/i.test(s)) return false;
    return true;
  },
  {
    message:
      "Path component must not contain traversal sequences ('..', '%2e'), null bytes, or '%00'",
  },
);
