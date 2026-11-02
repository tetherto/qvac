---
name: qv-quality-reporting
description: Run the deterministic code-quality audit, turn related findings into contextual remediation groups, prepare proposals, reconcile recurring runs, or configure twice-monthly quality reporting.
---

# Quality Reporting

Turn the repository's deterministic quality evidence into a short, actionable
review. This skill owns contextual grouping and triage; it does not replace the
underlying findings without explicit approval.

## Default Workflow

1. Run `pnpm quality:reporting` from the repository root.
2. Stop if the command fails, any detector reports diagnostics, or resolutions
   are withheld. Explain the incomplete evidence instead of proposing progress.
3. Read `.quality/triage.json` and
   [`references/triage-config.json`](references/triage-config.json). Establish the
   eligible candidate set: all candidates for an initial backlog review; on
   recurring runs, candidates with `new`, worsened `changed`, or `resolved`
   lifecycle evidence. Examine this lifecycle evidence before unchanged debt,
   regardless of severity. On recurring runs, include improved-only and unchanged
   debt only when the user asks for backlog review, after lifecycle work.
4. Form cohesive remediation groups across the eligible candidate set. Read only
   the source or architecture files needed to judge those groups, then:
   - combine candidates only when they share one root cause and fit one focused PR;
   - split a candidate when it contains independent remediations;
   - preserve every covered finding fingerprint;
   - apply approved merge/split overrides from the config before new judgment.

   On recurring runs, apply lifecycle eligibility again after grouping so
   improved-only and unchanged subgroups enter only a requested backlog review.
5. Assign ownership and P1-P4 priority using the config plus evidence in the
   triage report. Never derive priority from finding count alone.
6. Build the review batch using [`references/ticket-template.md`](references/ticket-template.md):
   - Complete grouping and priority assignment for the full eligible set before
     selecting a page. Rank contextual groups by P1, P2, P3, then P4. On recurring
     backlog reviews, keep lifecycle work ahead of improved-only and unchanged
     debt, applying priority order within each set.
   - Break priority ties by the earliest contributing candidate's position in
     `.quality/triage.json`'s deterministically ranked `candidates` array. Merged
     groups take the best contributing rank; split groups share their source
     rank. Break remaining ties by `groupKey` in ascending lexical order.
   - Take the first ten groups from that ordered queue as the batch, or all of
     them when fewer remain. Never cap the source candidates before grouping
     and ranking.

   Write the final machine batch to `.quality/proposals.json`. Retain unreviewed
   candidates for later pages; do not discard them.
7. Show the batch in chat as a numbered, concise review. Use only local audit,
   triage, and user-provided evidence. State that existing external tickets have
   not been checked. A human handles any task-tracker reconciliation or updates.

## Review Shape

Introduce the batch with its review mode and selection order: lifecycle
eligibility, P1-P4 priority, then deterministic source rank.

For each proposal, show:

- proposal ID, P1-P4 priority, primary team, and collaborators;
- a two-to-four sentence explanation of what is wrong and where;
- one focused remediation boundary;
- compact evidence: paths, rules, severity, threshold excess, and Git activity;
- lifecycle context: new remediation, material regression, or apparent resolution
  requiring human review.

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

`pnpm quality:reporting` compares the current findings with the previous
successful run in `.quality/previous-run-baseline.json`. When no snapshot exists,
the first run uses the committed audit baseline. The command advances the local
snapshot only after complete analysis and successful triage. Do not delete it
between recurring runs.

Compare local lifecycle evidence by stable group key before proposing work:

- new actionable group: propose a remediation for human review;
- materially worse existing group: use `changes[].direction` and the retained
  before/after values to explain the regression;
- improved-only drift: do not describe it as a regression;
- apparently resolved group: show a review notice;
- unchanged group: stay silent.

Use [`references/scheduling.md`](references/scheduling.md) only when the user asks
to create or modify the twice-monthly automation.

## Feedback and Configuration

When the user corrects ownership, importance, or group cohesion, apply that
feedback to the current review. Offer a minimal update to
`references/triage-config.json` only when it expresses a reusable repository
rule. Do not store private task links, people, tokens, or transient ticket state in
repository files.
