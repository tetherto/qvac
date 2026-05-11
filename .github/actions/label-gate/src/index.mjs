// Action entrypoint. Reads inputs, runs the gate, writes the output.
//
// Exit policy:
//   - Hard misconfiguration (missing token, unreadable event payload,
//     unhandled API error) -> non-zero exit so the gate job goes red and
//     someone notices.
//   - Soft denial (label not applied, applier not trusted, etc.) ->
//     exit 0 with `authorised=false`. Downstream jobs gate on the output.

import { appendFile } from 'node:fs/promises';
import { GitHubClient, GitHubApiError } from './github-client.mjs';
import { gate, parseList, loadEventPayload } from './gate.mjs';

const annotate = (level, message) => {
  process.stdout.write(`::${level} title=label-gate::${message}\n`);
};
const notice = (m) => annotate('notice', m);
const warning = (m) => annotate('warning', m);
const error = (m) => annotate('error', m);

function getInput(name, { required = false } = {}) {
  // Composite/JS actions both expose inputs as INPUT_<NAME_UPPERCASED>
  // with hyphens replaced by underscores.
  const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[key];
  const value = raw == null ? '' : raw.trim();
  if (required && !value) {
    throw new Error(`required input '${name}' is missing`);
  }
  return value;
}

async function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) throw new Error('GITHUB_OUTPUT is not set');
  await appendFile(file, `${name}=${value}\n`);
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!eventName) throw new Error('GITHUB_EVENT_NAME is not set');
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');

  const label = getInput('label') || 'verified';
  const teams = parseList(getInput('teams'));
  const users = parseList(getInput('users'));
  const token = getInput('github-token', { required: true });

  if (teams.length === 0 && users.length === 0) {
    warning(
      'both `teams` and `users` are empty — every PR-event run will be denied'
    );
  }

  let payload = {};
  if (eventPath) {
    payload = await loadEventPayload(eventPath);
  } else if (
    eventName === 'pull_request' ||
    eventName === 'pull_request_target'
  ) {
    throw new Error('GITHUB_EVENT_PATH is required for PR events');
  }

  const client = new GitHubClient({ token, repo });

  const decision = await gate({
    eventName,
    payload,
    repo,
    label,
    teams,
    users,
    client,
  });

  if (decision.applier) notice(`label applier resolved: '${decision.applier}'`);
  if (decision.stripped) warning(`stripped '${label}' label`);

  notice(`authorised=${decision.authorised} (${decision.reason})`);
  await setOutput('authorised', decision.authorised ? 'true' : 'false');
}

main().catch((e) => {
  if (e instanceof GitHubApiError) {
    error(
      `GitHub API error: ${e.message} (status=${e.status} method=${e.method} path=${e.path})`
    );
  } else {
    error(`unexpected failure: ${e.message ?? e}`);
  }
  process.exitCode = 1;
});
