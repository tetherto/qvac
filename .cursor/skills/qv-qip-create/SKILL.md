---
name: qv-qip-create
description: Drafts concise, stakeholder-facing QIPs with an explicit architectural decision, alternatives, and trade-offs. Use when creating a QIP, shaping a fuzzy proposal after qv-qip-triage, or invoking /qv-qip-create.
disable-model-invocation: true
---

# QIP Proposal Create

Help an author produce a concise architectural decision brief for Slack Canvas. It tells stakeholders why a decision is needed, what direction is proposed, where it fits in the architecture, and which important trade-offs they must accept. It is not a technical design document or implementation plan.

Use `qv-qip-triage` to decide whether a QIP is needed and `qv-qip-review` to assess an existing draft.

## Ground the proposal

Before drafting:

1. Read [references/qip-template.md](references/qip-template.md).
2. Read `docs/architecture/PRINCIPLES.md`.
3. When the proposal affects public SDK API, native bindings, runtime, mobile support, storage, transport, model registry, release flow, or security boundaries, inspect the relevant current docs or code. Establish the current behavior and proposed architectural delta.

Do not draft from general knowledge alone. Ground substantive claims in user-provided context, repository sources, or clearly labeled assumptions. Do not invent motivations, commitments, supported platforms, release plans, security or performance properties, or ownership decisions.

Investigation may be extensive; publication should not be. Use research to validate and compress the QIP rather than reproducing it.

## Intake and readiness

Ask only for missing decision context, one question at a time unless the user requests a batch. A terse or fuzzy prompt requires at least one clarifying question. Skip questions when the brief already satisfies the readiness gate or the user requests a first pass with assumptions.

A QIP is ready to draft when these are known:

- problem and why a decision is needed now;
- affected architectural or product surface and current behavior;
- one recommended direction and the exact approval ask;
- at least one credible alternative;
- decision-driving benefits, costs, and new responsibilities;
- relevant trust-boundary, compatibility, migration, or release impact.

A technology list, package name, or desired outcome without this context is a fuzzy idea. Help the author shape it, but do not choose the primary motivation or direction for them. If no direction is ready to recommend, continue discovery or explain what is missing; do not label an option survey as an approval-ready QIP.

## Draft contract

- Target 600-900 words of proposal content and treat 1,200 words as a soft ceiling, excluding the approvers table and short supporting-material links.
- Write at the architectural level: responsibilities, boundaries, interactions, and constraints that could change approval.
- Cover security, compatibility, migration, and release effects only when decision-relevant. If an unchanged dimension is likely to concern reviewers, address it in one sentence rather than adding a boilerplate section.
- Use a diagram only when a boundary is otherwise hard to understand. Link it or use a normal image reference; never embed base64 image data.
- Move API sketches, file-level changes, protocols, complete failure-mode analysis, rollout steps, test plans, phase breakdowns, and large comparisons to linked technical notes, diagrams, research, or PoC PRs unless the detail is itself the decision.
- Never claim human approval.

Before keeping a paragraph, ask whether it helps a reviewer approve, reject, or reshape the direction. If not, remove it or move it to supporting material. If the draft exceeds the soft ceiling, shorten it before proposing a separate supporting file; create that file only when the user requested or agreed to it.

## Consultation

Return a `People to consult before posting` note for the author, outside the Canvas-ready QIP unless requested otherwise. Name at most three roles or groups, combining related expertise:

- the owning team lead;
- Lead / Architect for technical validation;
- a cross-cutting expert when runtime, transport, storage, security, registry, native builds, or public SDK API is affected.

Final approvers come from the current template; do not treat them as default early-drafting consultees unless the proposal is strategic. Advice is direction plus reasoning, not a vote.

## Save and present

For a non-trivial or iterative draft, use the user's path or default to `arch/qips/<short-slug>.md` in this repository. Save only the approvers table, proposal sections, and supporting-material links; keep consultation in the response.

For a file-based draft, return the path, a brief summary, and the consultation note. Do not paste the QIP unless asked. For a chat-only draft, show the consultation note first and then the Canvas-ready QIP.

After saving, re-read the draft and verify its word count, template structure, links, and absence of embedded image data.

If the user asks whether the draft is ready to post, suggest `qv-qip-review`.
