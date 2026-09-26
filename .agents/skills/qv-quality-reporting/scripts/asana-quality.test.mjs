import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { applyQualityProposals } from "./asana-quality.mjs";

const SOURCE_HASH = `sha256:${"a".repeat(64)}`;

test("dry-run reconciles proposals without writing", async (t) => {
  const fake = await fakeAsana(t);

  const result = await applyQualityProposals({
    proposalBatch: batch([proposal()]),
    report: triageReport(),
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  });

  assert.deepEqual(result.actions, [
    { id: "quality-001", action: "create", outcome: "would-create" },
  ]);
  assert.equal(fake.requests.filter(({ method }) => method !== "GET").length, 0);
});

test("apply creates only an explicitly approved proposal", async (t) => {
  const fake = await fakeAsana(t);
  const proposalBatch = batch([
    proposal(),
    proposal({ id: "quality-002", groupKey: "sdk-other-debt" }),
  ]);

  const result = await applyQualityProposals({
    proposalBatch,
    report: triageReport(),
    approvedIds: ["quality-001"],
    apply: true,
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  });

  assert.deepEqual(result.actions, [
    {
      id: "quality-001",
      action: "create",
      outcome: "created",
      taskGid: "created-task",
    },
  ]);
  const writes = fake.requests.filter(({ method }) => method === "POST");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tasks");
  assert.deepEqual(writes[0].body.data.projects, ["project-1"]);
  assert.match(writes[0].body.data.notes, /QVAC-QUALITY-GROUP: inference-consumer-wrapper/);
  assert.equal("assignee" in writes[0].body.data, false);
  assert.equal("due_on" in writes[0].body.data, false);
  assert.equal("completed" in writes[0].body.data, false);
});

test("an existing exact group marker suppresses duplicate creation", async (t) => {
  const fake = await fakeAsana(t, {
    tasks: [
      {
        gid: "existing-task",
        name: "Existing quality task",
        notes: "QVAC-QUALITY-GROUP: inference-consumer-wrapper",
      },
    ],
  });

  const result = await applyQualityProposals({
    proposalBatch: batch([proposal()]),
    report: triageReport(),
    approvedIds: ["quality-001"],
    apply: true,
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  });

  assert.deepEqual(result.actions, [
    {
      id: "quality-001",
      action: "create",
      outcome: "existing",
      taskGid: "existing-task",
    },
  ]);
  assert.equal(fake.requests.filter(({ method }) => method === "POST").length, 0);
});

test("exact marker reconciliation follows Asana search pagination", async (t) => {
  const fake = await fakeAsana(t, {
    taskPages: [
      [{ gid: "possible-task", name: "Possible", notes: "related quality work" }],
      [{
        gid: "existing-task",
        name: "Existing quality task",
        notes: "QVAC-QUALITY-GROUP: inference-consumer-wrapper",
      }],
    ],
  });

  const result = await applyQualityProposals({
    proposalBatch: batch([proposal()]),
    report: triageReport(),
    approvedIds: ["quality-001"],
    apply: true,
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  });

  assert.equal(result.actions[0].outcome, "existing");
  assert.equal(fake.requests.filter(({ method }) => method === "GET").length, 2);
  assert.equal(fake.requests.filter(({ method }) => method === "POST").length, 0);
});

test("an approved regression adds a comment to the marked task", async (t) => {
  const fake = await fakeAsana(t, {
    tasks: [
      {
        gid: "existing-task",
        name: "Existing quality task",
        notes: "QVAC-QUALITY-GROUP: inference-consumer-wrapper",
      },
    ],
  });

  const result = await applyQualityProposals({
    proposalBatch: batch([proposal({ action: "comment" })]),
    report: triageReport(),
    approvedIds: ["quality-001"],
    apply: true,
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  });

  assert.deepEqual(result.actions, [
    {
      id: "quality-001",
      action: "comment",
      outcome: "commented",
      taskGid: "existing-task",
    },
  ]);
  const write = fake.requests.find(({ method }) => method === "POST");
  assert.equal(write.path, "/tasks/existing-task/stories");
  assert.match(write.body.data.text, /materially worsened/i);
  assert.match(write.body.data.text, /QVAC-QUALITY-GROUP: inference-consumer-wrapper/);
});

test("stale proposals are rejected before any Asana request", async (t) => {
  const fake = await fakeAsana(t);
  const staleReport = { ...triageReport(), sourceReportHash: `sha256:${"b".repeat(64)}` };

  await assert.rejects(
    applyQualityProposals({
      proposalBatch: batch([proposal()]),
      report: staleReport,
      config: asanaConfig(),
      token: "test-token",
      apiBase: fake.url,
    }),
    /source report hash does not match/i,
  );
  assert.equal(fake.requests.length, 0);
});

test("unknown approvals and empty apply approvals are rejected", async () => {
  await assert.rejects(
    applyQualityProposals({
      proposalBatch: batch([proposal()]),
      report: triageReport(),
      approvedIds: ["quality-999"],
      apply: true,
      config: asanaConfig(),
      token: "test-token",
    }),
    /unknown proposal id/i,
  );
  await assert.rejects(
    applyQualityProposals({
      proposalBatch: batch([proposal()]),
      report: triageReport(),
      approvedIds: [],
      apply: true,
      config: asanaConfig(),
      token: "test-token",
    }),
    /at least one approved proposal id/i,
  );
  await assert.rejects(
    applyQualityProposals({
      proposalBatch: batch([proposal()]),
      report: triageReport(),
      approvedIds: ["quality-001", "quality-001"],
      apply: true,
      config: asanaConfig(),
      token: "test-token",
    }),
    /duplicate approved proposal id/i,
  );
});

test("withheld resolutions and task-completion actions are rejected", async () => {
  await assert.rejects(
    applyQualityProposals({
      proposalBatch: { ...batch([proposal()]), resolutionStatus: "withheld" },
      report: { ...triageReport(), resolutionStatus: "withheld" },
      config: asanaConfig(),
      token: "test-token",
    }),
    /resolutions are withheld/i,
  );
  await assert.rejects(
    applyQualityProposals({
      proposalBatch: batch([proposal({ action: "complete" })]),
      report: triageReport(),
      config: asanaConfig(),
      token: "test-token",
    }),
    /unsupported proposal action/i,
  );
});

test("resolution notices never write to Asana", async (t) => {
  const fake = await fakeAsana(t);

  const result = await applyQualityProposals({
    proposalBatch: batch([proposal({ action: "resolution-notice" })]),
    report: triageReport(),
    approvedIds: ["quality-001"],
    apply: true,
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  });

  assert.deepEqual(result.actions, [
    {
      id: "quality-001",
      action: "resolution-notice",
      outcome: "review-only",
    },
  ]);
  assert.equal(fake.requests.length, 0);
});

test("an unchanged reported regression is silent on later runs", async (t) => {
  const fake = await fakeAsana(t, {
    tasks: [
      {
        gid: "existing-task",
        name: "Existing quality task",
        notes: "QVAC-QUALITY-GROUP: inference-consumer-wrapper",
      },
    ],
  });
  const input = {
    proposalBatch: batch([proposal({ action: "comment" })]),
    report: triageReport(),
    approvedIds: ["quality-001"],
    apply: true,
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  };

  const first = await applyQualityProposals(input);
  const requestCount = fake.requests.length;
  const second = await applyQualityProposals({
    ...input,
    apply: false,
    state: first.nextState,
  });

  assert.deepEqual(second.actions, [
    { id: "quality-001", action: "comment", outcome: "unchanged" },
  ]);
  assert.equal(fake.requests.length, requestCount);
});

test("a later measurement regression is not hidden by reporting state", async (t) => {
  const fake = await fakeAsana(t, {
    tasks: [
      {
        gid: "existing-task",
        name: "Existing quality task",
        notes: "QVAC-QUALITY-GROUP: inference-consumer-wrapper",
      },
    ],
  });
  const proposalBatch = batch([proposal({ action: "comment" })]);
  const first = await applyQualityProposals({
    proposalBatch,
    report: triageReport(),
    approvedIds: ["quality-001"],
    apply: true,
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  });
  const worsenedReport = triageReport();
  worsenedReport.candidates[0].changes[0].measurement.after.value = 160;
  worsenedReport.candidates[0].findingEvidence[0].measurement.value = 160;

  const second = await applyQualityProposals({
    proposalBatch,
    report: worsenedReport,
    state: first.nextState,
    config: asanaConfig(),
    token: "test-token",
    apiBase: fake.url,
  });

  assert.deepEqual(second.actions, [
    {
      id: "quality-001",
      action: "comment",
      outcome: "would-comment",
      taskGid: "existing-task",
    },
  ]);
});

test("reporting state for a split group ignores sibling fingerprint changes", async () => {
  const splitProposal = proposal({
    action: "resolution-notice",
    findingFingerprints: ["quality-v1:abc"],
  });
  const first = await applyQualityProposals({
    proposalBatch: batch([splitProposal]),
    report: triageReport(),
    approvedIds: ["quality-001"],
    apply: true,
    config: asanaConfig(),
    token: "test-token",
  });
  const siblingChanged = triageReport();
  siblingChanged.candidates[0].findingEvidence[1].lifecycle = "resolved";
  siblingChanged.candidates[0].lifecycle.existing = 0;
  siblingChanged.candidates[0].lifecycle.resolved = 1;
  siblingChanged.candidates[0].activeFindingCount = 1;
  siblingChanged.candidates[0].severityCounts.advisory = 0;

  const second = await applyQualityProposals({
    proposalBatch: batch([splitProposal]),
    report: siblingChanged,
    state: first.nextState,
    config: asanaConfig(),
    token: "test-token",
  });

  assert.deepEqual(second.actions, [
    { id: "quality-001", action: "resolution-notice", outcome: "unchanged" },
  ]);
});

function proposal(overrides = {}) {
  return {
    id: "quality-001",
    groupKey: "inference-consumer-wrapper",
    candidateIds: ["hotspot-v1:abc"],
    action: "create",
    title: "Reduce overlapping complexity in consumer wrapper",
    priority: "P2",
    owner: "SDK",
    collaborators: [],
    summary: "The wrapper contains overlapping length and complexity findings.",
    priorityRationale: "It is frequently changed production orchestration code.",
    remediationBoundary: "Extract one cohesive request-processing boundary.",
    evidence: ["packages/inference/src/consumer-wrapper.tsx: 4 findings"],
    findingFingerprints: ["quality-v1:abc", "quality-v1:def"],
    ...overrides,
  };
}

function batch(proposals) {
  return {
    schemaVersion: 1,
    sourceReportHash: SOURCE_HASH,
    resolutionStatus: "complete",
    proposals,
  };
}

function triageReport() {
  return {
    schemaVersion: 1,
    sourceReportHash: SOURCE_HASH,
    resolutionStatus: "complete",
    candidates: [
      {
        id: "hotspot-v1:abc",
        hotspot: {
          id: "hotspot-v1:abc",
          kind: "file",
          severity: "high",
          findingCount: 2,
          rules: ["structure/function-lines"],
          fingerprints: ["quality-v1:abc", "quality-v1:def"],
          path: "packages/inference/src/consumer-wrapper.tsx",
          symbols: ["run#1"],
        },
        lifecycle: { new: 0, changed: 1, existing: 1, resolved: 0 },
        severityCounts: { high: 1, advisory: 1 },
        activeFindingCount: 2,
        activeSeverity: "high",
        findingEvidence: [
          {
            fingerprint: "quality-v1:abc",
            lifecycle: "changed",
            severity: "high",
            measurement: { value: 120, unit: "code lines" },
          },
          {
            fingerprint: "quality-v1:def",
            lifecycle: "existing",
            severity: "advisory",
            measurement: { value: 70, unit: "code lines" },
          },
        ],
        changes: [
          {
            fingerprint: "quality-v1:abc",
            detector: "structure",
            rule: "function-lines",
            subject: {
              kind: "function",
              path: "packages/inference/src/consumer-wrapper.tsx",
              symbol: "run#1",
            },
            primaryLocation: {
              path: "packages/inference/src/consumer-wrapper.tsx",
              line: 20,
            },
            direction: "worsened",
            measurement: {
              before: { value: 80, unit: "code lines" },
              after: { value: 120, unit: "code lines" },
            },
          },
        ],
        sourceProfile: "production",
        maxThresholdRatio: 2.4,
        git: [],
      },
    ],
  };
}

function asanaConfig() {
  return {
    asana: {
      workspace: { gid: "workspace-1" },
      project: { gid: "project-1" },
    },
  };
}

async function fakeAsana(t, { tasks = [], taskPages = null } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({ method: request.method, path: request.url.split("?")[0], body });

    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      if (taskPages !== null) {
        const offset = new URL(request.url, "http://localhost").searchParams.get("offset");
        const pageIndex = offset === null ? 0 : Number(offset.replace("page-", ""));
        const nextIndex = pageIndex + 1;
        response.end(JSON.stringify({
          data: taskPages[pageIndex] ?? [],
          next_page: nextIndex < taskPages.length ? { offset: `page-${nextIndex}` } : null,
        }));
        return;
      }
      response.end(JSON.stringify({ data: tasks }));
      return;
    }
    if (request.url === "/tasks") {
      response.end(JSON.stringify({ data: { gid: "created-task" } }));
      return;
    }
    response.end(JSON.stringify({ data: { gid: "created-story" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
