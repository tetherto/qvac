import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import {
  bootstrapProject,
  auditTsDoc,
} from "../scripts/api-docs/audit-tsdoc.js";
import type { AuditResult } from "../scripts/api-docs/types.js";

/**
 * Ratchet this upward as TSDoc coverage improves.
 * To find the current value, run: npm run docs:audit-tsdoc
 */
const COMPLETENESS_THRESHOLD = 20;

const CRITICAL_FUNCTIONS = [
  "completion",
  "loadModel",
];

const SDK_PATH = path.resolve(
  process.env.SDK_PATH ||
    path.join(process.cwd(), "..", "..", "packages", "sdk"),
);

describe("tsdoc-completeness", () => {
  let result: AuditResult;

  beforeAll(async () => {
    const project = await bootstrapProject(SDK_PATH);
    result = await auditTsDoc(project, SDK_PATH, { quiet: true });
  }, 60_000);

  it(`overall completeness is at least ${COMPLETENESS_THRESHOLD}%`, () => {
    expect(result.completenessPercent).toBeGreaterThanOrEqual(
      COMPLETENESS_THRESHOLD,
    );
  });

  it("extracted a non-trivial number of functions", () => {
    expect(result.total).toBeGreaterThan(10);
  });

  it.each(CRITICAL_FUNCTIONS)(
    "%s has complete TSDoc",
    (name) => {
      const diag = result.diagnostics.find((d) => d.functionName === name);
      if (!diag) return; // function not exported (yet); skip silently
      expect(
        diag.missingParams,
        `${name}: missing @param for ${diag.missingParams.join(", ")}`,
      ).toHaveLength(0);
      expect(diag.missingReturns, `${name}: missing @returns`).toBe(false);
      expect(diag.missingThrows, `${name}: missing @throws`).toBe(false);
    },
  );
});
