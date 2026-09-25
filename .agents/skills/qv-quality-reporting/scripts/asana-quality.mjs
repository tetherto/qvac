#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { getAsanaToken } from "../../_lib/developer-workflow/asana.mjs";
import { loadConfig } from "../../_lib/developer-workflow/config.mjs";

const DEFAULT_API_BASE = "https://app.asana.com/api/1.0";
const ALLOWED_ACTIONS = new Set(["create", "comment", "resolution-notice"]);
const ALLOWED_PRIORITIES = new Set(["P1", "P2", "P3", "P4"]);

export async function applyQualityProposals({
  proposalBatch,
  report,
  approvedIds = [],
  apply = false,
  reconcile = true,
  config = null,
  token = null,
  apiBase = DEFAULT_API_BASE,
  fetchImpl = fetch,
  state = null,
  onStateChange = null,
}) {
  validateInputs({ proposalBatch, report, approvedIds, apply });
  if (apply && !reconcile) {
    throw new Error("Offline reconciliation cannot be combined with --apply");
  }

  const selected = selectProposals(proposalBatch.proposals, approvedIds);
  const candidateById = new Map(report.candidates.map((candidate) => [candidate.id, candidate]));
  const nextState = normalizeState(state);

  if (!reconcile) {
    return {
      mode: "offline-dry-run",
      actions: selected.map((proposal) => {
        const evidenceHash = proposalEvidenceHash(proposal, candidateById);
        return wasReported(nextState, proposal, evidenceHash)
          ? unchangedAction(proposal)
          : offlineAction(proposal);
      }),
      nextState,
    };
  }

  validateAsanaContext(config, token);
  const client = asanaClient({ apiBase, token, fetchImpl });
  const actions = [];
  for (const proposal of selected) {
    const evidenceHash = proposalEvidenceHash(proposal, candidateById);
    if (wasReported(nextState, proposal, evidenceHash)) {
      actions.push(unchangedAction(proposal));
      continue;
    }
    const action = await reconcileProposal({ proposal, apply, config, client });
    actions.push(action);
    if (apply && shouldRemember(action.outcome)) {
      nextState.groups[proposal.groupKey] = {
        action: proposal.action,
        evidenceHash,
      };
      if (onStateChange !== null) {
        await onStateChange(nextState);
      }
    }
  }

  return { mode: apply ? "apply" : "dry-run", actions, nextState };
}

function selectProposals(proposals, approvedIds) {
  if (approvedIds.length === 0) return proposals;
  const proposalsById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  return approvedIds.map((id) => proposalsById.get(id));
}

async function reconcileProposal({ proposal, apply, config, client }) {
  if (proposal.action === "resolution-notice") {
    return { id: proposal.id, action: proposal.action, outcome: "review-only" };
  }

  const matches = await findGroupMatches(client, config, proposal.groupKey);
  if (isAmbiguous(matches)) {
    return {
      id: proposal.id,
      action: proposal.action,
      outcome: "ambiguous",
      candidateTaskGids: [...matches.exact, ...matches.possible].map(({ gid }) => gid),
    };
  }

  const existing = matches.exact[0];
  return proposal.action === "create"
    ? reconcileCreation({ proposal, existing, apply, config, client })
    : reconcileComment({ proposal, existing, apply, client });
}

function isAmbiguous(matches) {
  return matches.exact.length > 1
    || (matches.exact.length === 0 && matches.possible.length > 0);
}

async function reconcileCreation({ proposal, existing, apply, config, client }) {
  if (existing) {
    return {
      id: proposal.id,
      action: proposal.action,
      outcome: "existing",
      taskGid: existing.gid,
    };
  }
  if (!apply) return { id: proposal.id, action: proposal.action, outcome: "would-create" };

  const task = await client.request("/tasks", {
    method: "POST",
    body: {
      name: `[${proposal.priority}] ${proposal.title}`,
      notes: ticketNotes(proposal),
      projects: [config.asana.project.gid],
    },
  });
  return {
    id: proposal.id,
    action: proposal.action,
    outcome: "created",
    taskGid: task.gid,
  };
}

async function reconcileComment({ proposal, existing, apply, client }) {
  if (!existing) {
    return { id: proposal.id, action: proposal.action, outcome: "missing-existing" };
  }
  if (!apply) {
    return {
      id: proposal.id,
      action: proposal.action,
      outcome: "would-comment",
      taskGid: existing.gid,
    };
  }
  await client.request(`/tasks/${encodeURIComponent(existing.gid)}/stories`, {
    method: "POST",
    body: { text: regressionComment(proposal) },
  });
  return {
    id: proposal.id,
    action: proposal.action,
    outcome: "commented",
    taskGid: existing.gid,
  };
}

function validateInputs({ proposalBatch, report, approvedIds, apply }) {
  if (proposalBatch?.schemaVersion !== 1 || !Array.isArray(proposalBatch.proposals)) {
    throw new Error("Proposal file must use schemaVersion 1 and contain proposals");
  }
  if (report?.schemaVersion !== 1 || typeof report.sourceReportHash !== "string") {
    throw new Error("Triage report must use schemaVersion 1 and contain sourceReportHash");
  }
  if (proposalBatch.sourceReportHash !== report.sourceReportHash) {
    throw new Error("Proposal source report hash does not match the current triage report");
  }
  if (proposalBatch.resolutionStatus !== "complete" || report.resolutionStatus !== "complete") {
    throw new Error("Cannot reconcile quality proposals while resolutions are withheld");
  }
  if (!Array.isArray(approvedIds)) {
    throw new Error("Approved proposal IDs must be an array");
  }
  if (new Set(approvedIds).size !== approvedIds.length) {
    throw new Error("Duplicate approved proposal ID");
  }
  if (apply && approvedIds.length === 0) {
    throw new Error("--apply requires at least one approved proposal ID");
  }

  const ids = new Set();
  const groupKeys = new Set();
  for (const proposal of proposalBatch.proposals) {
    validateProposal(proposal);
    if (ids.has(proposal.id)) throw new Error(`Duplicate proposal ID: ${proposal.id}`);
    if (groupKeys.has(proposal.groupKey)) {
      throw new Error(`Duplicate proposal group key: ${proposal.groupKey}`);
    }
    ids.add(proposal.id);
    groupKeys.add(proposal.groupKey);
  }
  for (const id of approvedIds) {
    if (!ids.has(id)) throw new Error(`Unknown proposal ID: ${id}`);
  }
}

function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object") throw new Error("Invalid proposal entry");
  for (const field of [
    "id",
    "groupKey",
    "title",
    "owner",
    "summary",
    "priorityRationale",
    "remediationBoundary",
  ]) {
    if (typeof proposal[field] !== "string" || proposal[field].trim() === "") {
      throw new Error(`Proposal ${proposal.id || "<unknown>"} requires ${field}`);
    }
  }
  if (!ALLOWED_ACTIONS.has(proposal.action)) {
    throw new Error(`Unsupported proposal action: ${proposal.action}`);
  }
  if (!ALLOWED_PRIORITIES.has(proposal.priority)) {
    throw new Error(`Unsupported proposal priority: ${proposal.priority}`);
  }
  for (const field of ["candidateIds", "collaborators", "evidence", "findingFingerprints"]) {
    if (!Array.isArray(proposal[field])) {
      throw new Error(`Proposal ${proposal.id} requires array field ${field}`);
    }
  }
  if (proposal.findingFingerprints.length === 0) {
    throw new Error(`Proposal ${proposal.id} must cover at least one finding fingerprint`);
  }
}

function validateAsanaContext(config, token) {
  if (!config?.asana?.workspace?.gid) throw new Error("Asana workspace GID is not configured");
  if (!config?.asana?.project?.gid) throw new Error("Asana project GID is not configured");
  if (!token) throw new Error("Asana token is required for reconciliation");
}

function offlineAction(proposal) {
  const outcome = proposal.action === "resolution-notice"
    ? "review-only"
    : proposal.action === "create"
      ? "would-create-unreconciled"
      : "would-comment-unreconciled";
  return { id: proposal.id, action: proposal.action, outcome };
}

function normalizeState(value) {
  if (value === null || value === undefined) {
    return { schemaVersion: 1, groups: {} };
  }
  if (value.schemaVersion !== 1 || !isRecord(value.groups)) {
    throw new Error("Quality reporting state must use schemaVersion 1 and contain groups");
  }
  const groups = {};
  for (const [groupKey, entry] of Object.entries(value.groups)) {
    if (
      !isRecord(entry)
      || !ALLOWED_ACTIONS.has(entry.action)
      || typeof entry.evidenceHash !== "string"
    ) {
      throw new Error(`Invalid quality reporting state for group ${groupKey}`);
    }
    groups[groupKey] = { action: entry.action, evidenceHash: entry.evidenceHash };
  }
  return { schemaVersion: 1, groups };
}

function proposalEvidenceHash(proposal, candidateById) {
  const coveredFingerprints = new Set(proposal.findingFingerprints);
  const foundFingerprints = new Set();
  const candidates = [...new Set(proposal.candidateIds)].map((candidateId) => {
    const candidate = candidateById.get(candidateId);
    if (candidate === undefined) {
      throw new Error(`Proposal ${proposal.id} references unknown candidate ID: ${candidateId}`);
    }
    const findingEvidence = candidate.findingEvidence
      .filter(({ fingerprint }) => coveredFingerprints.has(fingerprint))
      .map((evidence) => {
        foundFingerprints.add(evidence.fingerprint);
        return evidence;
      });
    const changes = candidate.changes.filter(({ fingerprint }) => {
      return coveredFingerprints.has(fingerprint);
    });
    return {
      id: candidate.id,
      findingEvidence,
      changes,
    };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));
  for (const fingerprint of coveredFingerprints) {
    if (!foundFingerprints.has(fingerprint)) {
      throw new Error(`Proposal ${proposal.id} references uncovered fingerprint: ${fingerprint}`);
    }
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(candidates)).digest("hex")}`;
}

function wasReported(state, proposal, evidenceHash) {
  if (proposal.action === "create") return false;
  const previous = state.groups[proposal.groupKey];
  return previous?.action === proposal.action && previous.evidenceHash === evidenceHash;
}

function unchangedAction(proposal) {
  return { id: proposal.id, action: proposal.action, outcome: "unchanged" };
}

function shouldRemember(outcome) {
  return new Set(["created", "existing", "commented", "review-only"]).has(outcome);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asanaClient({ apiBase, token, fetchImpl }) {
  const base = apiBase.replace(/\/$/, "");
  return {
    async requestEnvelope(path, { method = "GET", body = null } = {}) {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === null ? {} : { "Content-Type": "application/json" }),
        },
        body: body === null ? undefined : JSON.stringify({ data: body }),
      });
      const text = await response.text();
      const parsed = text === "" ? {} : parseJsonResponse(text);
      if (!response.ok) {
        const detail = parsed?.errors?.[0]?.message || response.statusText;
        throw new Error(`Asana ${method} ${path} failed (${response.status}): ${detail}`);
      }
      return parsed;
    },
    async request(path, options = {}) {
      const envelope = await this.requestEnvelope(path, options);
      return envelope.data;
    },
  };
}

async function findGroupMatches(client, config, groupKey) {
  const marker = groupMarker(groupKey);
  const tasks = [];
  const seenOffsets = new Set();
  let offset = null;
  do {
    const query = new URLSearchParams({
      "projects.any": config.asana.project.gid,
      text: marker,
      opt_fields: "gid,name,notes,completed",
      limit: "100",
      ...(offset === null ? {} : { offset }),
    });
    const page = await client.requestEnvelope(
      `/workspaces/${encodeURIComponent(config.asana.workspace.gid)}/tasks/search?${query}`,
    );
    tasks.push(...(page.data || []));
    offset = page.next_page?.offset ?? null;
    if (offset !== null && seenOffsets.has(offset)) {
      throw new Error("Asana search returned a repeated pagination offset");
    }
    if (offset !== null) seenOffsets.add(offset);
  } while (offset !== null);
  return {
    exact: tasks.filter(({ notes = "" }) => notes.split("\n").includes(marker)),
    possible: tasks.filter(({ notes = "" }) => !notes.split("\n").includes(marker)),
  };
}

function ticketNotes(proposal) {
  const collaborators = proposal.collaborators.length === 0
    ? "None"
    : proposal.collaborators.join(", ");
  return [
    proposal.summary,
    "",
    `Priority rationale: ${proposal.priorityRationale}`,
    `Primary team: ${proposal.owner}`,
    `Collaborators: ${collaborators}`,
    `Remediation boundary: ${proposal.remediationBoundary}`,
    "",
    "Evidence:",
    ...proposal.evidence.map((item) => `- ${item}`),
    "",
    groupMarker(proposal.groupKey),
    `QVAC-QUALITY-FINDINGS: ${[...proposal.findingFingerprints].sort().join(",")}`,
  ].join("\n");
}

function regressionComment(proposal) {
  return [
    "The deterministic code-quality evidence for this group materially worsened.",
    "",
    proposal.summary,
    `Priority rationale: ${proposal.priorityRationale}`,
    "Evidence:",
    ...proposal.evidence.map((item) => `- ${item}`),
    "",
    groupMarker(proposal.groupKey),
  ].join("\n");
}

function groupMarker(groupKey) {
  return `QVAC-QUALITY-GROUP: ${groupKey}`;
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Asana returned a non-JSON response");
  }
}

function parseArgs(argv) {
  const options = {
    proposals: ".quality/proposals.json",
    report: ".quality/triage.json",
    approvedIds: [],
    apply: false,
    offline: false,
    apiBase: DEFAULT_API_BASE,
    state: ".quality/reporting-state.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") options.apply = false;
    else if (argument === "--offline") options.offline = true;
    else if (argument === "--proposals") options.proposals = requiredValue(argv, ++index, argument);
    else if (argument === "--report") options.report = requiredValue(argv, ++index, argument);
    else if (argument === "--state") options.state = requiredValue(argv, ++index, argument);
    else if (argument === "--approve") {
      options.approvedIds = requiredValue(argv, ++index, argument)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    } else if (argument === "--api-base") {
      options.apiBase = requiredValue(argv, ++index, argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

async function main(argv) {
  const options = parseArgs(argv);
  const proposalBatch = JSON.parse(readFileSync(options.proposals, "utf8"));
  const report = JSON.parse(readFileSync(options.report, "utf8"));
  const state = existsSync(options.state)
    ? JSON.parse(readFileSync(options.state, "utf8"))
    : null;
  let config = null;
  let token = null;
  if (!options.offline) {
    config = loadConfig({ requireFile: true });
    token = getAsanaToken(config);
  }
  const result = await applyQualityProposals({
    proposalBatch,
    report,
    approvedIds: options.approvedIds,
    apply: options.apply,
    reconcile: !options.offline,
    config,
    token,
    apiBase: options.apiBase,
    state,
    onStateChange: options.apply
      ? (nextState) => writeState(options.state, nextState)
      : null,
  });
  const { nextState: _nextState, ...displayResult } = result;
  process.stdout.write(`${JSON.stringify(displayResult, null, 2)}\n`);
}

function writeState(path, state) {
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
