// Pure decision logic for label-gate.
//
// Exports:
//   parseList(input)              -> string[]   (CSV/newline-tolerant)
//   normaliseLogin(login)         -> string     (lowercased, trimmed)
//   loadEventPayload(path)        -> object     (filesystem read + JSON.parse)
//   gate(opts)                    -> Decision   (the actual policy)
//
// The gate function is async only because the GitHub client is. All policy
// branches are exercised in test/gate.test.mjs without touching the network.

import { readFile } from 'node:fs/promises';

const TRUSTED_EVENTS = new Set([
  'push',
  'workflow_dispatch',
  'workflow_call',
  'schedule',
  'release',
  // repository_dispatch is API-initiated. Triggering it requires a token
  // with `repo` scope on the target repo, so the dispatcher is by
  // construction trusted; no PR review/label flow applies. Without this
  // entry, any workflow that gates on label-gate but triggers via
  // repository_dispatch would fail closed and never run.
  'repository_dispatch',
]);

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

// Commit-status context used to bind a `verified` approval to the exact commit
// SHA it was approved on. Set by label-gate on a trusted `labeled` event; read
// by every subsequent privileged run so that authorisation follows the approved
// SHA, not workflow-event ordering (closes the draft->ready and close->reopen
// flip bypasses where a stale approval for commit A authorised a later commit B).
export const APPROVAL_STATUS_CONTEXT = 'qvac/fork-verified';

/**
 * @typedef {object} Decision
 * @property {boolean} authorised
 * @property {string} reason
 * @property {boolean} [stripped]   true iff the label was actively removed
 * @property {string} [applier]
 */

/**
 * Split a CSV/newline-tolerant input string into a deduped, trimmed,
 * non-empty list. Whitespace inside an entry is preserved (logins and
 * team slugs cannot contain whitespace, so this is fine).
 *
 * @param {string | undefined | null} input
 * @returns {string[]}
 */
export function parseList(input) {
  if (input == null) return [];
  const seen = new Set();
  const out = [];
  for (const raw of String(input).split(/[\s,]+/)) {
    const s = raw.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * GitHub logins are case-insensitive. Normalise consistently so users
 * entered as "Alice" in `users` match an event sender of "alice".
 */
export function normaliseLogin(login) {
  return String(login ?? '').trim().toLowerCase();
}

/**
 * Read and parse the event payload at GITHUB_EVENT_PATH.
 *
 * @param {string} path
 * @returns {Promise<object>}
 */
export async function loadEventPayload(path) {
  if (!path) throw new Error('event payload path is empty');
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`event payload at ${path} is not valid JSON: ${e.message}`);
  }
}

/**
 * Decide whether `login` is authorised by the configured users allowlist
 * or any of the configured teams. Short-circuits on first hit; never
 * issues team API calls when `users` already covers the login.
 *
 * @param {string} login
 * @param {{users: Set<string>, teams: string[], org: string, client: import('./github-client.mjs').GitHubClient}} ctx
 * @returns {Promise<{authorised: boolean, source: 'users' | 'teams' | 'none', team?: string}>}
 */
async function isTrustedActor(login, { users, teams, org, client }) {
  const norm = normaliseLogin(login);
  if (!norm) return { authorised: false, source: 'none' };
  if (users.has(norm)) return { authorised: true, source: 'users' };
  for (const team of teams) {
    if (await client.isTeamMember(org, team, login)) {
      return { authorised: true, source: 'teams', team };
    }
  }
  return { authorised: false, source: 'none' };
}

/**
 * Run the policy. Caller passes a fully-typed input bag and an injectable
 * client; the function returns a Decision and never throws on
 * policy denials (only on hard misuse like missing required fields).
 *
 * @param {object} opts
 * @param {string} opts.eventName
 * @param {object} opts.payload                 - parsed event JSON
 * @param {string} opts.repo                    - "owner/name"
 * @param {string} opts.label
 * @param {string[]} opts.teams
 * @param {string[]} opts.users
 * @param {import('./github-client.mjs').GitHubClient} opts.client
 * @returns {Promise<Decision>}
 */
export async function gate({
  eventName,
  payload,
  repo,
  label,
  teams,
  users,
  client,
}) {
  if (!eventName) throw new Error('gate: eventName is required');
  if (!repo || !repo.includes('/')) {
    throw new Error('gate: repo must be "owner/name"');
  }
  if (!label) throw new Error('gate: label is required');

  if (TRUSTED_EVENTS.has(eventName)) {
    return { authorised: true, reason: `trusted event source (${eventName})` };
  }

  if (!PR_EVENTS.has(eventName)) {
    return {
      authorised: false,
      reason: `unrecognised event '${eventName}' — failing closed`,
    };
  }

  // Internal same-repo PRs are inherently trusted: pushing a branch to the
  // base repo requires write access, so there is no untrusted fork code to
  // gate. The verified label is required for EXTERNAL FORK PRs only.
  const baseRepo = String(repo).trim().toLowerCase();
  const headRepo = String(payload?.pull_request?.head?.repo?.full_name ?? '')
    .trim()
    .toLowerCase();
  if (headRepo && headRepo === baseRepo) {
    // Internal draft PRs run nothing until marked ready-for-review (the
    // workflow re-triggers on ready_for_review), keeping label-gate in
    // lockstep with ci-router's draft gate.
    if (payload?.pull_request?.draft === true) {
      return {
        authorised: false,
        reason:
          'internal draft PR — authorised on ready-for-review (verified not required)',
      };
    }
    return {
      authorised: true,
      reason: 'internal same-repo PR — verified not required (fork-only gate)',
    };
  }

  if (teams.length === 0 && users.length === 0) {
    return {
      authorised: false,
      reason: 'no teams or users configured — nothing can authorise this PR',
    };
  }

  const usersSet = new Set(users.map(normaliseLogin));
  const org = repo.split('/')[0];
  const action = String(payload?.action ?? '');
  const sender = payload?.sender?.login ?? '';
  const headSha = String(payload?.pull_request?.head?.sha ?? '').trim();
  const prNumber =
    payload?.pull_request?.number ?? payload?.number ?? null;

  if (!prNumber) {
    return {
      authorised: false,
      reason: 'could not resolve PR number from event payload',
    };
  }

  // Authoritative current label state from the PR object. The timeline is
  // append-only history; trusting it alone would allow a bypass where
  // someone removes the gate label (no event subscribed to `unlabeled`)
  // and then any subsequent `synchronize` re-authorises against the
  // stale labeled event in the timeline. Always require the label to
  // actually be on the PR right now. Checked before any API call so
  // unrelated PRs cost us nothing.
  const currentLabels = Array.isArray(payload?.pull_request?.labels)
    ? payload.pull_request.labels
        .map((l) => l?.name)
        .filter((n) => typeof n === 'string')
    : [];
  const labelCurrentlyApplied = currentLabels.includes(label);

  if (!labelCurrentlyApplied) {
    return {
      authorised: false,
      reason: `'${label}' label is not currently applied to PR #${prNumber}`,
    };
  }

  // Any change to an external fork invalidates the commit-specific approval,
  // regardless of who pushed it (including a maintainer using "allow edits").
  // Only reachable when the label IS currently applied (above), so a strip
  // will always have something to remove.
  if (action === 'synchronize') {
    const stripped = await client.stripLabel(prNumber, label);
    return {
      authorised: false,
      reason: `external fork synchronize by '${sender}' — label stripped; re-review required`,
      stripped,
    };
  }

  // Resolve the label applier.
  const isOurLabeledEvent =
    action === 'labeled' && payload?.label?.name === label;
  let applier = '';
  if (isOurLabeledEvent) {
    applier = sender;
  } else {
    applier = (await client.findLabelApplier(prNumber, label)) ?? '';
  }

  if (!applier) {
    return {
      authorised: false,
      reason: `no '${label}' label has been applied to PR #${prNumber}`,
    };
  }

  const applierTrust = await isTrustedActor(applier, {
    users: usersSet,
    teams,
    org,
    client,
  });

  if (applierTrust.authorised) {
    const detail =
      applierTrust.source === 'users'
        ? 'in users allowlist'
        : `member of '${org}/${applierTrust.team}'`;

    // SHA-bound approval. Workflow-event ordering is NOT proof of
    // authorisation: a stale approval for commit A must never authorise a
    // later commit B that rode in on a draft->ready or close->reopen flip
    // while A's run was still active. Bind the approval to the exact commit
    // via a commit status, and require every subsequent privileged run to
    // carry that trusted status on its CURRENT head SHA.
    if (!headSha) {
      return {
        authorised: false,
        reason:
          'head SHA missing from event payload — cannot bind approval to a commit',
        applier,
      };
    }

    if (isOurLabeledEvent) {
      // The approval moment: a trusted actor just applied the label to the
      // current head. Record the approval against this exact SHA.
      const bound = await client.setCommitStatus(headSha, {
        state: 'success',
        context: APPROVAL_STATUS_CONTEXT,
        description: `verified by ${applier}`.slice(0, 140),
      });
      return {
        authorised: true,
        reason: `label applier '${applier}' is trusted (${detail}); approval bound to ${headSha}`,
        applier,
        approvedSha: headSha,
        bound,
      };
    }

    // Any other event (opened / reopened / ready_for_review / edited /
    // labeled-with-a-different-label / manual re-run): the applier being
    // trusted only proves SOME commit was once approved. Authorise ONLY if
    // THIS head SHA is the commit that was approved.
    const approvedForHead = await client.hasApprovalStatus(
      headSha,
      APPROVAL_STATUS_CONTEXT,
    );
    if (approvedForHead) {
      return {
        authorised: true,
        reason: `head ${headSha} carries a trusted '${label}' approval`,
        applier,
        approvedSha: headSha,
      };
    }
    return {
      authorised: false,
      reason: `'${label}' is applied by a trusted actor, but head ${headSha} is not the approved commit — re-review required (approval is SHA-bound, not order-based)`,
      applier,
    };
  }

  // Non-trusted applier. If they JUST added the label themselves
  // (action='labeled' for our gate label), strip it so the visible PR
  // state matches the security state. Without the strip the label
  // would sit there falsely advertising "verified" until the next
  // synchronize from a non-trusted actor cleans it up — that's both a
  // confusing UX and a minor social-engineering vector ("look, the PR
  // is verified"). For non-labeled events (opened/reopened/edited
  // /labeled-with-different-label/...) we resolved the applier from
  // the timeline; we don't strip in that case because the applier
  // status may have changed since the label was applied legitimately
  // (e.g. team member who later left), and the synchronize path will
  // strip on the next push if the actor is also untrusted.
  if (isOurLabeledEvent) {
    const stripped = await client.stripLabel(prNumber, label);
    return {
      authorised: false,
      reason: `non-trusted '${applier}' applied '${label}' — label stripped`,
      applier,
      stripped,
    };
  }

  return {
    authorised: false,
    reason: `label applier '${applier}' is not in users allowlist or any configured team`,
    applier,
  };
}
