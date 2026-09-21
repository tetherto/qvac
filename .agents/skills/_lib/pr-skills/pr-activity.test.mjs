import assert from "node:assert/strict";
import test from "node:test";

import {
  computeE2e,
  formatE2eLine,
  groupTeamPRsByTier,
  hasLeadApprovalInPod,
  isDocsOnly,
  pingTargetsForPod,
  rolesForPod,
} from "./pr-activity.mjs";

const OWNED = ["packages/sdk/"];
const DOCS = ["docs/website/content/docs/"];

function files(...paths) {
  return paths.map((path) => ({ path }));
}

test("isDocsOnly: docs-only vs mixed vs impl", () => {
  assert.equal(
    isDocsOnly(files("docs/website/content/docs/sdk.md"), OWNED, DOCS),
    true,
  );
  assert.equal(isDocsOnly(files("packages/sdk/src/index.ts"), OWNED, DOCS), false);
  assert.equal(
    isDocsOnly(
      files("packages/sdk/src/index.ts", "docs/website/content/docs/sdk.md"),
      OWNED,
      DOCS,
    ),
    false,
  );
  assert.equal(isDocsOnly(files("README.md"), OWNED, DOCS), false);
  assert.equal(isDocsOnly(files("docs/website/content/docs/sdk.md"), OWNED, []), false);
  assert.equal(
    isDocsOnly(files("docs/website/content/docs/sdk.md"), OWNED, undefined),
    false,
  );
});

test("computeE2e: PR-triggered names drop skipped electron/snap", () => {
  const e2e = computeE2e([
    {
      name: "run-tests / desktop-tests / [desktop] test (qvac-ubuntu2204-x64-gpu)",
      state: "FAILURE",
    },
    { name: "run-tests / android-tests / [android] device-farm", state: "SUCCESS" },
    { name: "run-tests / ios-tests / [ios] device-farm", state: "SUCCESS" },
    { name: "run-tests / electron-tests", state: "SKIPPED" },
    { name: "run-tests / snap-tests", state: "SKIPPED" },
    { name: "run-tests / resolve", state: "SUCCESS" },
  ]);
  assert.deepEqual(e2e, {
    android: "success",
    desktop: "failure",
    ios: "success",
  });
  assert.equal(formatE2eLine(e2e), "e2e: ✅ android · ❌ desktop · ✅ ios");
});

test("computeE2e: workflow_dispatch names without run-tests prefix", () => {
  const e2e = computeE2e([
    { name: "android-tests / [android] build", state: "SUCCESS" },
    { name: "desktop-tests", state: "FAILURE" },
  ]);
  assert.deepEqual(e2e, { android: "success", desktop: "failure" });
});

test("computeE2e: skipped-only platforms omitted; empty is not run", () => {
  const desktopOnly = computeE2e([
    {
      name: "run-tests / desktop-tests / [desktop] test (qvac-ubuntu2204-x64-gpu)",
      state: "SUCCESS",
    },
    { name: "run-tests / android-tests", state: "SKIPPED" },
    { name: "run-tests / ios-tests", state: "SKIPPED" },
    { name: "run-tests / electron-tests", state: "SKIPPED" },
  ]);
  assert.deepEqual(desktopOnly, { desktop: "success" });
  assert.equal(formatE2eLine({}), "e2e: ⏸ not run");
});

test("rolesForPod: honorary leads approve but are not Core or ping targets", () => {
  const roles = rolesForPod({
    leads: ["lead"],
    members: ["member", "lead"],
    approvalLeads: ["honorary", "lead"],
  });
  assert.deepEqual(roles.allTeam, ["lead", "member"]);
  assert.deepEqual(roles.approvalLeads, ["honorary"]);
  assert.deepEqual(roles.leadApprovers, ["lead", "honorary"]);
  assert.ok(!roles.allTeam.includes("honorary"));

  const pending = {
    author: { login: "outsider" },
    reviewState: new Map(),
  };
  assert.deepEqual(
    pingTargetsForPod(pending, roles).map((target) => target.login).sort(),
    ["lead", "member"],
  );
  assert.equal(hasLeadApprovalInPod(pending, roles), false);
  assert.equal(
    hasLeadApprovalInPod(
      {
        author: { login: "outsider" },
        reviewState: new Map([["honorary", "APPROVED"]]),
      },
      roles,
    ),
    true,
  );
});

test("groupTeamPRsByTier: docs-only PRs go in the docs lane", () => {
  const docsPr = { authorTier: "core", docsOnly: true, number: 1 };
  const implPr = { authorTier: "core", docsOnly: false, number: 2 };
  const grouped = groupTeamPRsByTier({
    reReviewPRs: [],
    stalePRs: [],
    activePRs: [docsPr, implPr],
    approvedPRs: [],
  });
  assert.deepEqual(grouped.core.docs.activePRs, [docsPr]);
  assert.deepEqual(grouped.core.impl.activePRs, [implPr]);
});
