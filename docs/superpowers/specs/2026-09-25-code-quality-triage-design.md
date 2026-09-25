# Code Quality Triage and Reporting

## Purpose

Turn the deterministic code-quality audit into an actionable maintenance
workflow. Humans must be able to see related hotspots, prioritize cohesive
remediation work using repository context, approve ticket proposals, and repeat
the process without duplicate Asana tasks.

The audit remains the evidence source. The triage layer groups and enriches that
evidence; it does not replace individual findings or claim that a mechanical
score represents business priority.

## User workflow

Invoking `qv-quality-reporting` runs the audit and triage commands, reviews the
top ten actionable groups, and presents ticket-ready proposals. Each proposal
contains the problem, location, evidence, priority rationale, primary team,
collaborators, remediation boundary, and covered finding fingerprints.

No Asana mutation occurs until the user approves specific proposals. Approved
new groups create tasks. Material regressions on groups with existing tasks
produce proposed comments. Apparently resolved groups produce review notices;
the workflow never completes their tasks automatically. Unchanged groups remain
silent.

The skill also supports a scheduling mode for a twice-monthly Codex heartbeat.
The heartbeat runs the same approval-gated workflow and notifies the user only
when new groups, material regressions, apparent resolutions, analysis failures,
or required decisions exist. The default schedule is the 1st and 15th at 10:00
in the user's local timezone and can be changed when the automation is created.

## Architecture

The workflow has five boundaries:

1. `quality:audit` produces normalized findings, fingerprints, baseline state,
   and the detailed snapshot report.
2. The report renderer adds a short deterministic hotspot summary while keeping
   the rule-by-rule evidence unchanged.
3. `quality:triage` consumes the machine report and Git history, producing
   `.quality/triage.json` and `.quality/triage.md` with stable candidate groups
   and reproducible ranking signals.
4. `qv-quality-reporting` applies architectural judgment, skill-owned ownership
   and importance guidance, and human feedback to create the review batch.
5. A helper owned by the new skill reconciles and mutates Asana only after
   explicit approval. `qv-asana-sync` is not changed.

Generated `.quality` artifacts are local and ignored. Repository configuration
contains no Asana task IDs, private links, tokens, or other private state.

## Deterministic hotspot summary

The current Markdown report gains `Hotspots` before the detailed findings.
Hotspots are a current-state snapshot and remain independent of baseline state.

File hotspots aggregate every structural and fan-out finding whose primary
subject is the same repository-relative file. A row shows the maximum severity,
finding count, involved rules, and the affected symbols. This makes overlapping
function length, complexity, nesting, file length, and fan-out evidence visible
together.

Dependency hotspots aggregate cycle findings through an overlap graph: cycles
are connected when they share a module, and each connected component is one
cluster. A row shows runtime and compile-time cycle counts, module count, and
the most frequently occurring hub modules. Detailed cycle paths stay in the
rule section.

The summary is ordered by maximum severity, finding count, and stable identity.
It is evidence for triage, not a ticket boundary.

## Candidate grouping

The triage builder creates candidates conservatively:

- one file candidate containing the file's structural and fan-out findings;
- one dependency candidate per overlapping cycle cluster;
- no automatic cross-file structural merge merely because files share a
  package or directory.

The skill may split a large candidate or combine adjacent candidates only when
they share one root cause and can reasonably be addressed by one focused pull
request. Human-approved merge and split decisions are represented as path and
group overrides in the skill's reference configuration so future runs can
reproduce them.

File candidate anchors use their repository-relative path. Cycle candidates
use canonical members and hub modules. A versioned SHA-256 candidate ID is
derived from the kind and anchor. Human-curated groups receive a stable,
descriptive group key. Asana reconciliation first uses that group key, then
finding overlap and path similarity. Ambiguous matches require human approval.

## Triage signals and priority

The deterministic output supplies evidence rather than a composite score:

- finding severity and amount beyond configured thresholds;
- number and types of overlapping findings;
- runtime versus compile-time dependency risk;
- new findings and measurement or severity regressions;
- commit count and most recent modification over the previous 180 days;
- dependency centrality already observable from finding relationships;
- production versus auxiliary source profile.

The skill adds module importance, public API exposure, architectural role,
team ownership, and remediation cohesion. Importance defaults and path
overrides live in the skill and may be refined from human feedback.

Final priority is a justified band, not an opaque number:

- `P1`: current correctness, initialization, security, or release risk in a
  critical path;
- `P2`: high-impact maintainability debt in important or frequently changed
  production code;
- `P3`: bounded debt worth scheduling but without urgent operational risk;
- `P4`: opportunistic cleanup, low-churn auxiliary code, or weak evidence.

Every proposal states which evidence led to the band.

## Ownership

Default ownership follows the architecture workshop scenarios with the current
team consolidation:

- SDK owns `inference`, `sdk`, `sdk-python`, `rag`, `ai-sdk-provider`, `cli`,
  `error`, `logging`, `model-fit`, and `test-suite`.
- NLP & Media Gen owns `llm-llamacpp`, `embed-llamacpp`, `diffusion-cpp`,
  `ocr-ggml`, `classification-ggml`, and `vla-ggml`.
- Speech owns the speech packages plus `translation-nmtcpp` and language
  detection.

Vision routes to NLP & Media Gen; Translation routes to Speech. Path overrides
handle renamed packages and exceptions. A cohesive cross-team fix remains one
group with a primary owner and collaborators instead of being split into
artificially independent tickets.

## Asana reconciliation and safety

Ticket descriptions include a machine-readable footer containing the group key
and finding fingerprints. Before proposing creation, the skill searches the
configured Asana project for that marker. Exact matches are existing tickets.
Likely overlap is displayed for confirmation.

The helper accepts a generated proposal file and explicit approved proposal
IDs. It refuses an empty approval list, unknown IDs, duplicate group keys,
analysis with withheld resolutions, or a proposal file whose source report hash
no longer matches the current report. It never assigns a person, due date, or
completion state. Tokens and project details come from the existing local
developer-workflow configuration.

## Human outputs

`.quality/triage.md` begins with the top ten groups and supports filtering by
team, package, priority, and status. Each group includes:

- proposed priority, owner, and collaborators;
- a two-to-four sentence explanation of what is wrong and where;
- the cohesive remediation boundary;
- compact evidence with links or repository-relative locations;
- lifecycle state: new proposal, existing ticket, regressed, apparently
  resolved, unchanged, or ambiguous match.

The machine artifact retains all groups even when only ten appear in the human
review. Lower-ranked groups can be requested in subsequent pages.

## Verification

Unit tests cover file hotspot aggregation, cycle clustering, deterministic IDs,
Git churn parsing, report ordering, ownership overrides, proposal paging,
stale-report rejection, and approval filtering. Integration-style tests run the
audit and triage commands in temporary Git repositories. The Asana helper uses a
mock HTTP endpoint for creation and reconciliation tests; no test contacts live
Asana.

Human-perspective verification invokes the new skill's documented default flow,
checks that the first screen is understandable without reading JSON, confirms a
single approved proposal can be selected without editing files, and verifies
that rerunning an unchanged report produces no duplicate-ticket proposal.
