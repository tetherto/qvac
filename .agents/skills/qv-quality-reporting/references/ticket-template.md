# Quality Proposal Contract

Use this contract for `.quality/proposals.json` and the corresponding human
review. The file is ignored local state; it must not contain Asana task IDs,
private links, tokens, assignees, or due dates.

The helper separately maintains `.quality/reporting-state.json` with group keys,
actions, and deterministic evidence hashes. That ignored checkpoint is not a
ticket registry and must never contain Asana task IDs or links.

## Machine shape

```json
{
  "schemaVersion": 1,
  "sourceReportHash": "sha256 from .quality/triage.json",
  "resolutionStatus": "complete",
  "proposals": [
    {
      "id": "quality-001",
      "groupKey": "inference-consumer-wrapper-complexity",
      "candidateIds": ["hotspot-v1:..."],
      "action": "create",
      "title": "Reduce overlapping complexity in inference consumer wrapper",
      "priority": "P2",
      "owner": "SDK",
      "collaborators": [],
      "summary": "Two to four sentences explaining the problem, impact, and location.",
      "priorityRationale": "Concrete importance, severity, churn, and lifecycle evidence.",
      "remediationBoundary": "One focused outcome that should fit a small PR.",
      "evidence": [
        "packages/inference/src/example.ts: high complexity and three overlapping length findings"
      ],
      "findingFingerprints": ["finding-v1:..."]
    }
  ]
}
```

Allowed actions are:

- `create`: create a new task only when no exact group marker already exists;
- `comment`: add a material-regression comment to an existing marked task;
- `resolution-notice`: display for human review only; never mutate or complete a
  task.

Proposal IDs are short review handles, stable only within the generated batch.
`groupKey` is the durable, descriptive identity used for reconciliation.

## Human form

Show each proposal as:

```text
quality-001 · P2 · SDK
Reduce overlapping complexity in inference consumer wrapper

<two-to-four sentence summary>
Boundary: <one focused remediation outcome>
Why P2: <specific evidence>
Evidence: <compact path/rule/churn list>
```

Keep summaries diagnostic, not prescriptive. Do not promise that a refactor will
fix behavior unless the evidence demonstrates a behavior defect.

## Ticket notes and marker

For `create`, the helper builds ticket notes from the proposal and appends:

```text
QVAC-QUALITY-GROUP: <groupKey>
QVAC-QUALITY-FINDINGS: <sorted comma-separated fingerprints>
```

For `comment`, describe only what materially worsened since the prior report and
include the same group marker. The helper searches the configured Asana project
for the exact marker before any write.
