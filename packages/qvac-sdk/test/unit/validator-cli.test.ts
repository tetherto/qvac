// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const VALIDATOR_PATH = path.join(
  __dirname,
  "../../../../scripts/sdk/validator.cjs",
);
const MOCKS_DIR = path.join(__dirname, "../mocks");

function loadMock(filename: string): string {
  return fs.readFileSync(path.join(MOCKS_DIR, filename), "utf-8");
}

function runValidator(args: string): { exitCode: number; output: string } {
  try {
    const output = execSync(`node ${VALIDATOR_PATH} ${args}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, output };
  } catch (error) {
    const err = error as { status: number; stdout: string; stderr: string };
    return {
      exitCode: err.status || 1,
      output: err.stdout + err.stderr,
    };
  }
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ============================================================
// Commit Message Validation - Valid
// ============================================================

const validMessages = [
  { msg: "feat: add new feature", desc: "simple feat" },
  { msg: "fix: resolve bug", desc: "simple fix" },
  { msg: "doc: update readme", desc: "simple doc" },
  { msg: "test: add unit tests", desc: "simple test" },
  { msg: "chore: update deps", desc: "simple chore" },
  { msg: "infra: add ci workflow", desc: "simple infra" },
  { msg: "feat[api]: add streaming support", desc: "feat with api tag" },
  { msg: "fix[bc]: change return type", desc: "fix with bc tag" },
  { msg: "feat[mod]: add new models", desc: "feat with mod tag" },
  { msg: "chore[skiplog]: internal cleanup", desc: "chore with skiplog tag" },
];

for (const { msg, desc } of validMessages) {
  test(`commit valid: ${desc}`, (t) => {
    const result = runValidator(`--type=commit --msg="${msg}"`);
    t.is(result.exitCode, 0);
    t.ok(result.output.includes("✅ Valid commit message"));
  });
}

// ============================================================
// Commit Message Validation - Invalid
// ============================================================

const invalidMessages = [
  { msg: "add feature", desc: "missing prefix" },
  { msg: "feat add feature", desc: "missing colon" },
  { msg: "FEAT: add feature", desc: "uppercase prefix" },
  { msg: "mod: add models", desc: "mod as prefix (now a tag)" },
  { msg: "feat[invalid]: something", desc: "invalid tag" },
  { msg: "feat:", desc: "empty subject" },
  { msg: "feat:  ", desc: "whitespace-only subject" },
];

for (const { msg, desc } of invalidMessages) {
  test(`commit invalid: ${desc}`, (t) => {
    const result = runValidator(`--type=commit --msg="${msg}"`);
    t.is(result.exitCode, 1);
    t.ok(result.output.includes("❌ Invalid commit message"));
  });
}

// ============================================================
// Commit Message Validation - Auto-skipped
// ============================================================

const skippedMessages = [
  { msg: "Merge pull request #123", desc: "merge commit" },
  { msg: "Merge branch 'dev' into main", desc: "merge branch" },
  { msg: "1.0.0", desc: "version bump" },
  { msg: "v2.3.4", desc: "version bump with v prefix" },
  { msg: 'Revert "feat: add feature"', desc: "revert commit" },
  { msg: "squash! fix: bug fix", desc: "squash commit" },
];

for (const { msg, desc } of skippedMessages) {
  test(`commit skipped: ${desc}`, (t) => {
    const result = runValidator(`--type=commit --msg="${msg}"`);
    t.is(result.exitCode, 0);
    t.ok(result.output.includes("✅ Valid commit message"));
  });
}

// ============================================================
// PR Title Validation - Valid
// ============================================================

const validTitles = [
  {
    title: "QVAC-123 feat: add feature",
    desc: "standard format",
    body: "pr-body-simple.md",
  },
  {
    title: "SDK-456 fix: resolve bug",
    desc: "different project",
    body: "pr-body-simple.md",
  },
  {
    title: "ABC-1 doc: update docs",
    desc: "single digit ticket",
    body: "pr-body-simple.md",
  },
  {
    title: "QVAC-99999 chore: cleanup",
    desc: "large ticket number",
    body: "pr-body-simple.md",
  },
  {
    title: "QVAC-123 feat[api]: add streaming",
    desc: "with api tag",
    body: "pr-body-api-valid.md",
  },
  {
    title: "QVAC-123 fix[bc]: breaking change",
    desc: "with bc tag",
    body: "pr-body-bc-valid.md",
  },
  {
    title: "QVAC-123 feat[mod]: add models",
    desc: "with mod tag",
    body: "pr-body-mod-valid-added.md",
  },
  {
    title: "feat[notask]: quick fix",
    desc: "notask without ticket",
    body: "pr-body-simple.md",
  },
  {
    title: "QVAC-123 chore[skiplog]: internal change",
    desc: "skiplog tag",
    body: "pr-body-simple.md",
  },
];

for (const { title, desc, body: bodyFile } of validTitles) {
  test(`PR valid: ${desc}`, (t) => {
    const body = loadMock(bodyFile);
    const result = runValidator(
      `--type=pr --title="${title}" --body=${escapeShellArg(body)}`,
    );
    t.is(result.exitCode, 0);
    t.ok(result.output.includes("✅ Valid PR"));
  });
}

// ============================================================
// PR Title Validation - Invalid
// ============================================================

const invalidTitles = [
  { title: "feat: missing ticket", desc: "missing ticket" },
  { title: "QVAC feat: missing dash", desc: "malformed ticket" },
  { title: "123 feat: numeric only ticket", desc: "no project prefix" },
  { title: "QVAC-123 mod: models update", desc: "mod as prefix" },
  { title: "QVAC-123: missing prefix", desc: "missing prefix" },
  { title: "QVAC-123 FEAT: uppercase", desc: "uppercase prefix" },
];

for (const { title, desc } of invalidTitles) {
  test(`PR invalid: ${desc}`, (t) => {
    const body = loadMock("pr-body-simple.md");
    const result = runValidator(
      `--type=pr --title="${title}" --body=${escapeShellArg(body)}`,
    );
    t.is(result.exitCode, 1);
    t.ok(result.output.includes("❌ Invalid PR"));
  });
}

// ============================================================
// PR Body Validation - [bc] tag
// ============================================================

test("PR [bc]: accepts valid BEFORE/AFTER markers", (t) => {
  const body = loadMock("pr-body-bc-valid.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[bc]: breaking change" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes("✅ Valid PR"));
});

test("PR [bc]: accepts valid inline old/new comments", (t) => {
  const body = loadMock("pr-body-bc-valid-inline.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[bc]: breaking change" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes("✅ Valid PR"));
});

test("PR [bc]: rejects without BEFORE/AFTER examples", (t) => {
  const body = loadMock("pr-body-bc-invalid.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[bc]: breaking change" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("BEFORE/AFTER"));
});

// ============================================================
// PR Body Validation - [api] tag
// ============================================================

test("PR [api]: accepts with code blocks", (t) => {
  const body = loadMock("pr-body-api-valid.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[api]: add api" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes("✅ Valid PR"));
});

test("PR [api]: rejects without code blocks", (t) => {
  const body = loadMock("pr-body-api-invalid.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[api]: add api" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("fenced code block"));
});

// ============================================================
// PR Body Validation - [mod] tag
// ============================================================

test("PR [mod]: accepts only Added models section", (t) => {
  const body = loadMock("pr-body-mod-valid-added.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[mod]: add models" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes("✅ Valid PR"));
});

test("PR [mod]: accepts only Removed models section", (t) => {
  const body = loadMock("pr-body-mod-valid-removed.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[mod]: remove models" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes("✅ Valid PR"));
});

test("PR [mod]: accepts both Added and Removed sections", (t) => {
  const body = loadMock("pr-body-mod-valid-both.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[mod]: update models" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes("✅ Valid PR"));
});

test("PR [mod]: rejects without Models section", (t) => {
  const body = loadMock("pr-body-mod-invalid-no-section.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[mod]: add models" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("Models section"));
});

test("PR [mod]: rejects with Models section but no code blocks", (t) => {
  const body = loadMock("pr-body-mod-invalid-no-codeblock.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[mod]: add models" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("subsection"));
});

test("PR [mod]: rejects with empty body", (t) => {
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat[mod]: add models" --body=""`,
  );
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("Models section"));
});

// ============================================================
// Edge Cases
// ============================================================

test("edge: handles missing --msg argument for commit", (t) => {
  const result = runValidator("--type=commit");
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("--msg is required"));
});

test("edge: handles missing --title argument for PR", (t) => {
  const result = runValidator("--type=pr");
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("--title is required"));
});

test("edge: handles invalid type argument", (t) => {
  const result = runValidator("--type=invalid");
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("Invalid type"));
});

test("edge: handles no arguments", (t) => {
  const result = runValidator("");
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("Usage"));
});

test("edge: PR without body passes for non-special tags", (t) => {
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat: add feature" --body=""`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes("✅ Valid PR"));
});

test("edge: commit message with special characters", (t) => {
  const result = runValidator(
    `--type=commit --msg="feat: add support for 'quotes' and \\"escapes\\""`,
  );
  t.is(result.exitCode, 0);
});

test("edge: PR title with special characters in subject", (t) => {
  const body = loadMock("pr-body-simple.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 feat: add (parens) and dashes-here" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
});

// ============================================================
// Parsed Output Verification
// ============================================================

test("parsed: commit returns correct structure", (t) => {
  const result = runValidator(
    `--type=commit --msg="feat[api]: add streaming support"`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes('"prefix": "feat"'));
  t.ok(result.output.includes('"tags"'));
  t.ok(result.output.includes('"api"'));
  t.ok(result.output.includes('"subject": "add streaming support"'));
});

test("parsed: PR returns correct structure with ticket", (t) => {
  const body = loadMock("pr-body-bc-valid.md");
  const result = runValidator(
    `--type=pr --title="QVAC-123 fix[bc]: breaking change" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes('"ticket": "QVAC-123"'));
  t.ok(result.output.includes('"prefix": "fix"'));
  t.ok(result.output.includes('"bc"'));
});

test("parsed: PR with [notask] returns null ticket", (t) => {
  const body = loadMock("pr-body-simple.md");
  const result = runValidator(
    `--type=pr --title="feat[notask]: quick fix" --body=${escapeShellArg(body)}`,
  );
  t.is(result.exitCode, 0);
  t.ok(result.output.includes('"ticket": null'));
});
