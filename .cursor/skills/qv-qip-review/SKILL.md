---
name: qv-qip-review
description: Reviews QIP drafts for approval readiness, architectural fit, decision clarity, material trade-offs, and appropriate stakeholder detail. Use when reviewing a QIP or invoking /qv-qip-review.
---

# QIP Proposal Review

Review a QIP without substituting for its human approvers. Use `qv-qip-create` for first drafts and `qv-qip-triage` to decide whether a QIP is needed.

## Ground the review

1. Read [../qv-qip-create/references/qip-template.md](../qv-qip-create/references/qip-template.md).
2. Read `docs/architecture/PRINCIPLES.md`.
3. When the proposal changes runtime, package, plugin, registry, storage, transport, security, public API, release, or deployment boundaries, check its system fit against `docs/architecture/ARCHITECTURE.md` and the relevant current repository sources.

Do not infer approval, commitments, current behavior, or implementation feasibility without evidence. Treat principle conflicts as review findings, not automatic rejection, unless the proposal hides or misrepresents the conflict.

## Review criteria

### Decision readiness

- Problem explains what matters and why a decision is needed now.
- Solution recommends one direction and states the exact approval ask.
- Architectural responsibilities, boundaries, interactions, and rationale are concrete enough to evaluate.
- Obvious alternatives are addressed briefly or through linked research.
- Consequences state positive impact and the trade-offs reviewers must accept.
- Decision-relevant trust-boundary, compatibility, migration, and release effects are explicit.
- Likely scope misunderstandings are excluded explicitly, and the approvers table is preserved.

An unclear or absent recommended direction or approval ask is a blocker. Do not use length as a proxy for this check.

### Decision-brief quality

- Use 600-900 words as the target and 1,200 words as a soft ceiling for proposal content.
- Length above the ceiling is a suggested edit, not a blocker by itself.
- Flag specific passages when repetition or implementation detail buries the problem, recommended direction, architectural boundary, or accepted trade-offs.
- Recommend moving file lists, complete APIs, protocols, execution steps, test plans, rollout detail, exhaustive failure modes, and large comparisons to supporting material unless they directly affect approval.
- Check that repository research has been synthesized rather than reproduced, principle references explain a concrete fit or conflict, and images are linked rather than embedded as base64 data.

### Consultation

If consultation context is provided, check coverage of the owning team lead, Lead / Architect, and any relevant cross-cutting expertise. The consultation note belongs outside the Canvas-ready QIP, so its absence from the QIP is not a finding. Advice is direction plus reasoning, not a vote.

## Findings and severity

Separate:

- **Blockers:** the decision cannot responsibly be approved, such as no clear approval ask, an unsupported material claim, an unresolved architectural contradiction, or missing impact that could change the decision.
- **Clarifying questions:** answers would improve confidence but may not require restructuring the proposal.
- **Suggested edits:** concision, organization, supporting-document moves, and other improvements that do not block the decision.

Lead with findings ordered by approval risk and use line-specific references when possible:

```markdown
## Blockers
- ...

## Clarifying questions
- ...

## Suggested edits
- ...

## Approval readiness
Ready | Ready with minor edits | Not ready

## Slack comment
<optional concise paste-ready comment if requested>
```

Say explicitly when there are no blockers. Do not rewrite the whole QIP unless asked. Keep an optional Slack comment under one screen.
