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
]);

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

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
  const prNumber =
    payload?.pull_request?.number ?? payload?.number ?? null;

  if (!prNumber) {
    return {
      authorised: false,
      reason: 'could not resolve PR number from event payload',
    };
  }

  // Synchronize: protect against new commits from non-trusted actors.
  if (action === 'synchronize') {
    const senderTrust = await isTrustedActor(sender, {
      users: usersSet,
      teams,
      org,
      client,
    });
    if (!senderTrust.authorised) {
      const stripped = await client.stripLabel(prNumber, label);
      return {
        authorised: false,
        reason: `synchronize from non-trusted '${sender}' — label stripped`,
        stripped,
      };
    }
    // team-member synchronize falls through to the standard label check
  }

  // Resolve the label applier.
  let applier = '';
  if (action === 'labeled' && payload?.label?.name === label) {
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
    return {
      authorised: true,
      reason: `label applier '${applier}' is trusted (${detail})`,
      applier,
    };
  }

  return {
    authorised: false,
    reason: `label applier '${applier}' is not in users allowlist or any configured team`,
    applier,
  };
}
