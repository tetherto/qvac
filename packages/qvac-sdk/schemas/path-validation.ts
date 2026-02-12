import { z } from "zod";

/**
 * Zod refinement for path components that get joined to a base directory.
 *
 * STUB: accepts all strings. Traversal rejection not yet implemented.
 */
export const safePathComponent = z.string();
