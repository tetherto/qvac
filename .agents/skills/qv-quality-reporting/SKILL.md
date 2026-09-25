---
name: qv-quality-reporting
description: Run the deterministic code-quality audit, turn related findings into contextual remediation groups, prepare approval-gated Asana proposals, reconcile recurring runs, or configure twice-monthly quality reporting.
---

# Quality Reporting

Turn the repository's deterministic quality evidence into a short, actionable
review. This skill owns contextual grouping and triage; it does not replace the
underlying findings or mutate Asana without explicit approval.

## Default Workflow

1. Run `pnpm quality:reporting` from the repository root.
2. Stop if the command fails, any detector reports diagnostics, or resolutions
   are withheld. Explain the incomplete evidence instead of proposing progress.
3. Read `.quality/triage.json`,
   [`references/triage-config.json`](references/triage-config.json), and only the
   source or architecture files needed to understand the leading candidates.
4. Form cohesive remediation groups. Start with deterministic candidates, then:
   - combine candidates only when they share one root cause and fit one focused PR;
   - split a candidate when it contains independent remediations;
   - preserve every covered finding fingerprint;
   - apply approved merge/split overrides from the config before new judgment.
5. Assign ownership and P1-P4 priority using the config plus evidence in the
   triage report. Never derive priority from finding count alone.
6. Build the review batch using [`references/ticket-template.md`](references/ticket-template.md):
   - On the initial backlog review, begin with the deterministically ranked
     candidates.
   - On recurring runs, examine all `new`, worsened `changed`, and `resolved`
     lifecycle evidence before unchanged existing debt, regardless of severity.
     Skip improved-only and unchanged groups unless the user asks for backlog
     review.
   - Generate provisional proposals in pages, reconcile each page read-only,
     discard exact-existing and unchanged outcomes, and continue until ten
     actionable proposals remain or candidates are exhausted. Ambiguous matches
     count as actionable decisions. Never cap the source candidates before this
     backfill step.
   Write the final machine batch to `.quality/proposals.json`. Retain unreviewed
   candidates for later pages; do not discard them.
7. Reconcile each provisional page read-only with:

   ```bash
   node .agents/skills/qv-quality-reporting/scripts/asana-quality.mjs \
     --proposals .quality/proposals.json \
     --report .quality/triage.json
   ```

   Suppress exact duplicate creations and unchanged actions, surface ambiguous
   matches, and show the resulting final batch in chat as a numbered, concise
   review. If local Asana
   access is unavailable, label the proposals unreconciled and do not apply them
   until reconciliation succeeds.
8. End the initial run by asking the user which proposal IDs to approve. Do not
   use `--apply`, even if the user previously authorized analysis.
9. After the user explicitly approves IDs, rerun the helper for only that subset
   without `--apply` and show the exact actions. Stop if the match is ambiguous or
   the result differs materially from what the user approved. Otherwise run:

   ```bash
   node .agents/skills/qv-quality-reporting/scripts/asana-quality.mjs \
     --proposals .quality/proposals.json \
     --report .quality/triage.json \
     --approve <comma-separated-proposal-ids> \
     --apply
   ```

   Never infer approval for proposals the user did not name.

## Review Shape

For each proposal, show:

- proposal ID, P1-P4 priority, primary team, and collaborators;
- a two-to-four sentence explanation of what is wrong and where;
- one focused remediation boundary;
- compact evidence: paths, rules, severity, threshold excess, and Git activity;
- lifecycle action: create, comment on a materially worsened group, or review an
  apparent resolution.

Prefer source links in chat when a concrete line is available. Keep the
deterministic finding list in `.quality/report.md` as the evidence trail.

## Priority Judgment

- **P1:** evidenced current correctness, initialization, security, or release
  risk on a critical path. A high-severity smell alone is not P1.
- **P2:** material maintainability risk in important or frequently changed
  production code, especially when several findings describe one root cause.
- **P3:** bounded, credible debt worth scheduling without urgent operational
  risk.
- **P4:** opportunistic cleanup, low-churn auxiliary code, or weak evidence.

State the evidence that justifies the band. If importance or ownership is
uncertain, say so instead of inventing certainty.

## Recurring Runs

Reconcile by stable group marker before proposing work:

- new actionable group with no match: propose ticket creation;
- materially worse existing group: use `changes[].direction` and the retained
  before/after values to justify a proposed comment on its existing ticket;
- improved-only drift: do not describe it as a regression;
- apparently resolved group: show a review notice, never complete a task;
- unchanged group: stay silent;
- ambiguous match: request a decision and do not mutate Asana.

The helper records only the group action and deterministic evidence hash in
`.quality/reporting-state.json`. This ignored local checkpoint prevents the same
regression comment or resolution notice from being proposed repeatedly. It
contains no Asana IDs or private links. Do not delete it between recurring runs.

Use [`references/scheduling.md`](references/scheduling.md) only when the user asks
to create or modify the twice-monthly automation.

## Feedback and Configuration

When the user corrects ownership, importance, or group cohesion, apply that
feedback to the current review. Offer a minimal update to
`references/triage-config.json` only when it expresses a reusable repository
rule. Do not store task IDs, private Asana links, people, tokens, or transient
ticket state in repository files.
