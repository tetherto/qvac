// Unit tests for the gate decision logic.
//
// Run: node --test .github/actions/label-gate/test
//
// All tests are network-free; they pass a hand-rolled mock client into
// gate(). Each test asserts both the boolean decision and any expected
// side-effects (label strip).

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  gate,
  parseList,
  normaliseLogin,
  loadEventPayload,
} from '../src/gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

const REPO = 'tetherto/qvac';
const LABEL = 'verified';
const TEAMS = ['qvac-internal-dev', 'qvac-internal-merge', 'qvac-internal-release'];

function makeClient({ teamMembers = [], labelApplier = null, stripResult = true } = {}) {
  const members = new Set(teamMembers.map((s) => s.toLowerCase()));
  const calls = { isTeamMember: 0, findLabelApplier: 0, stripLabel: 0 };
  const stripped = [];
  return {
    calls,
    stripped,
    async isTeamMember(_org, _team, login) {
      calls.isTeamMember += 1;
      return members.has(String(login).toLowerCase());
    },
    async findLabelApplier(_pr, _label) {
      calls.findLabelApplier += 1;
      return labelApplier;
    },
    async stripLabel(pr, label) {
      calls.stripLabel += 1;
      stripped.push({ pr, label });
      return stripResult;
    },
  };
}

const loadFixture = (name) => loadEventPayload(join(FIXTURES, `${name}.json`));

const baseArgs = (overrides = {}) => ({
  repo: REPO,
  label: LABEL,
  teams: TEAMS,
  users: [],
  ...overrides,
});

// --- parseList ----------------------------------------------------------------

test('parseList: handles CSV, newlines, mixed, whitespace, dedupe, case-insensitive dedupe', () => {
  assert.deepEqual(parseList('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseList('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(parseList('a, b\n c , d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parseList('a,A,b,B'), ['a', 'b']);
  assert.deepEqual(parseList('  '), []);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(null), []);
  assert.deepEqual(parseList(undefined), []);
});

test('normaliseLogin: trims and lowercases', () => {
  assert.equal(normaliseLogin('  Alice '), 'alice');
  assert.equal(normaliseLogin('CHARLIE'), 'charlie');
  assert.equal(normaliseLogin(null), '');
  assert.equal(normaliseLogin(undefined), '');
});

// --- trusted event sources ---------------------------------------------------

for (const eventName of ['push', 'workflow_dispatch', 'workflow_call', 'schedule', 'release']) {
  test(`trusted event: ${eventName} -> authorised, no API calls`, async () => {
    const client = makeClient();
    const payload = await loadFixture(eventName === 'push' ? 'push' : 'workflow-dispatch');
    const d = await gate({ ...baseArgs(), eventName, payload, client });
    assert.equal(d.authorised, true);
    assert.match(d.reason, /trusted event/);
    assert.equal(client.calls.isTeamMember, 0);
    assert.equal(client.calls.findLabelApplier, 0);
    assert.equal(client.calls.stripLabel, 0);
  });
}

// --- unknown event ------------------------------------------------------------

test('unknown event: fail closed, no API calls', async () => {
  const client = makeClient();
  const d = await gate({
    ...baseArgs(),
    eventName: 'something_weird',
    payload: {},
    client,
  });
  assert.equal(d.authorised, false);
  assert.match(d.reason, /unrecognised event/);
});

// --- empty config -------------------------------------------------------------

test('empty teams + empty users on a PR event: fail closed', async () => {
  const client = makeClient();
  const payload = await loadFixture('labeled-team-member');
  const d = await gate({
    ...baseArgs({ teams: [], users: [] }),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.match(d.reason, /no teams or users configured/);
});

// --- labeled --------------------------------------------------------------

test("labeled by team member -> authorised; no timeline lookup", async () => {
  const client = makeClient({ teamMembers: ['alice-team-member'] });
  const payload = await loadFixture('labeled-team-member');
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, true);
  assert.equal(client.calls.findLabelApplier, 0, 'must skip timeline on labeled fast-path');
  assert.equal(d.applier, 'alice-team-member');
});

test('labeled by non-member -> not authorised', async () => {
  const client = makeClient({ teamMembers: [] });
  const payload = await loadFixture('labeled-non-member');
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.equal(d.applier, 'mallory-outsider');
  assert.equal(client.stripped.length, 0);
});

test('labeled by bot account -> not authorised (bots are never team members)', async () => {
  const client = makeClient({ teamMembers: [] });
  const payload = await loadFixture('labeled-by-bot');
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.equal(d.applier, 'renovate[bot]');
});

test('labeled by allowlisted user (case-insensitive) -> authorised, no team API call', async () => {
  const client = makeClient({ teamMembers: [] });
  const payload = await loadFixture('labeled-by-allowlisted-user');
  const d = await gate({
    ...baseArgs({ users: ['charlie-allowlisted'] }),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, true);
  assert.equal(d.applier, 'Charlie-Allowlisted');
  assert.match(d.reason, /in users allowlist/);
  assert.equal(client.calls.isTeamMember, 0);
});

// --- synchronize -------------------------------------------------------------

test('synchronize from non-team-member -> strip label, not authorised', async () => {
  const client = makeClient({ teamMembers: [] });
  const payload = await loadFixture('synchronize-non-member');
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.equal(d.stripped, true);
  assert.equal(client.stripped.length, 1);
  assert.equal(client.stripped[0].label, 'verified');
});

test('synchronize from team-member with team-member label applier -> authorised, no strip', async () => {
  const client = makeClient({
    teamMembers: ['alice-team-member'],
    labelApplier: 'alice-team-member',
  });
  const payload = await loadFixture('synchronize-team-member');
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, true);
  assert.equal(client.calls.stripLabel, 0);
  assert.equal(d.applier, 'alice-team-member');
});

test('synchronize from team-member with non-member label applier -> not authorised, no strip', async () => {
  const client = makeClient({
    teamMembers: ['alice-team-member'],
    labelApplier: 'mallory-outsider',
  });
  const payload = await loadFixture('synchronize-team-member');
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.equal(client.calls.stripLabel, 0, 'AC: do not strip on team-member synchronize');
  assert.equal(d.applier, 'mallory-outsider');
});

test('synchronize from team-member with no prior label -> not authorised', async () => {
  const client = makeClient({
    teamMembers: ['alice-team-member'],
    labelApplier: null,
  });
  const payload = await loadFixture('synchronize-team-member');
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.match(d.reason, /no 'verified' label/);
});

// --- non-labeled, non-synchronize PR actions (e.g. opened, reopened) ---------

test('opened PR with prior team-applied label -> authorised', async () => {
  const client = makeClient({
    teamMembers: ['alice-team-member'],
    labelApplier: 'alice-team-member',
  });
  const payload = {
    action: 'opened',
    number: 9999,
    pull_request: { number: 9999, labels: [{ name: 'verified' }] },
    sender: { login: 'mallory-outsider' },
  };
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, true);
  assert.equal(d.applier, 'alice-team-member');
});

test('opened PR with no label at all -> not authorised', async () => {
  const client = makeClient({
    teamMembers: ['alice-team-member'],
    labelApplier: null,
  });
  const payload = {
    action: 'opened',
    number: 9998,
    pull_request: { number: 9998, labels: [] },
    sender: { login: 'mallory-outsider' },
  };
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.match(d.reason, /not currently applied/);
});

// --- BYPASS REGRESSION: stale `labeled` event after the label was removed ---

test('REGRESSION: synchronize after label was removed -> deny even if timeline still shows trusted applier', async () => {
  // Scenario: Alice (team) labels the PR; Mallory removes the label off-band
  // (no `unlabeled` event subscribed); Alice pushes a new commit; the
  // synchronize event fires. The timeline still contains Alice's old
  // `labeled` event but the label is no longer on the PR. We must deny.
  const client = makeClient({
    teamMembers: ['alice-team-member'],
    labelApplier: 'alice-team-member',
  });
  const payload = {
    action: 'synchronize',
    number: 7777,
    pull_request: { number: 7777, labels: [] },
    sender: { login: 'alice-team-member' },
  };
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false, 'must deny when label is currently absent');
  assert.match(d.reason, /not currently applied/);
  assert.equal(
    client.calls.findLabelApplier,
    0,
    'must short-circuit before timeline lookup'
  );
});

test('REGRESSION: opened PR with stale labeled timeline but no current label -> deny', async () => {
  const client = makeClient({
    teamMembers: ['alice-team-member'],
    labelApplier: 'alice-team-member',
  });
  const payload = {
    action: 'reopened',
    number: 7778,
    pull_request: { number: 7778, labels: [{ name: 'something-else' }] },
    sender: { login: 'mallory-outsider' },
  };
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.match(d.reason, /not currently applied/);
});

test('synchronize from non-trusted with NO label currently applied -> deny, no API calls at all', async () => {
  const client = makeClient({ teamMembers: [] });
  const payload = {
    action: 'synchronize',
    number: 7779,
    pull_request: { number: 7779, labels: [] },
    sender: { login: 'mallory-outsider' },
  };
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, false);
  assert.match(d.reason, /not currently applied/);
  assert.equal(client.calls.stripLabel, 0, 'must not call strip when nothing to strip');
  assert.equal(
    client.calls.isTeamMember,
    0,
    'no point checking sender trust if the label is already absent'
  );
  assert.equal(client.calls.findLabelApplier, 0);
});

// --- input validation --------------------------------------------------------

test('missing PR number -> not authorised', async () => {
  const client = makeClient();
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload: { action: 'opened', sender: { login: 'x' } },
    client,
  });
  assert.equal(d.authorised, false);
  assert.match(d.reason, /could not resolve PR number/);
});

test('missing required gate args throw', async () => {
  await assert.rejects(
    () => gate({ ...baseArgs(), eventName: '', payload: {}, client: makeClient() }),
    /eventName is required/
  );
  await assert.rejects(
    () =>
      gate({
        ...baseArgs({ repo: 'no-slash' }),
        eventName: 'push',
        payload: {},
        client: makeClient(),
      }),
    /repo must be/
  );
  await assert.rejects(
    () =>
      gate({
        ...baseArgs({ label: '' }),
        eventName: 'push',
        payload: {},
        client: makeClient(),
      }),
    /label is required/
  );
});

// --- labeled action with non-matching label name -----------------------------

test('labeled with a different label still falls through to timeline lookup (verified label is currently applied)', async () => {
  const client = makeClient({
    teamMembers: ['alice-team-member'],
    labelApplier: 'alice-team-member',
  });
  const payload = {
    action: 'labeled',
    number: 5555,
    pull_request: {
      number: 5555,
      labels: [{ name: 'verified' }, { name: 'something-else' }],
    },
    label: { name: 'something-else' },
    sender: { login: 'mallory-outsider' },
  };
  const d = await gate({
    ...baseArgs(),
    eventName: 'pull_request_target',
    payload,
    client,
  });
  assert.equal(d.authorised, true);
  assert.equal(client.calls.findLabelApplier, 1, 'must check timeline since this event is for a different label');
  assert.equal(d.applier, 'alice-team-member');
});
