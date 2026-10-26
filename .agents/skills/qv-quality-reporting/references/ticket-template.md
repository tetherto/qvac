# Quality Proposal Contract

Use this contract for `.quality/proposals.json` and the corresponding human
review. The file is ignored local state. Keep private task links, credentials,
assignees, and due dates out of it. Proposals are local review artifacts, and a
human handles any task-tracker lookup or update.

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
      "action": "remediation",
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

Allowed actions describe local review only:

- `remediation`: propose work for a new actionable group;
- `regression-review`: explain a material regression in an existing group;
- `resolution-notice`: flag an apparent resolution for human review.

Proposal IDs are short review handles, stable only within the generated batch.
`groupKey` is the durable, descriptive identity used to compare local reports.

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

## Evidence identity

Retain `groupKey` and sorted `findingFingerprints` in the local proposal so a
human can trace it to the deterministic audit. For regressions, describe what
materially worsened since the prior local report. Do not search an external task
tracker to match these identifiers.
