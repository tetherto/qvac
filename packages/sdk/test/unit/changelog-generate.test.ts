// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// --- Generic script imports ---
const GENERIC_SCRIPT_PATH = path.join(
  __dirname,
  "../../../../scripts/generate-changelog-qvac.cjs",
);
const {
  extractVersionFromTag,
  resolveBaseRef,
  generateBasicChangelog,
  parseArgs,
} = require(GENERIC_SCRIPT_PATH);

// --- SDK wrapper imports ---
const SDK_SCRIPT_PATH = path.join(
  __dirname,
  "../../../../scripts/sdk/generate-changelog-sdk-pod.cjs",
);
const {
  extractCodeBlocks,
  extractBeforeAfter,
  extractModelNames,
  extractModelsSection,
  capitalize,
  generateChangelogEntry,
  generateChangelogFiles,
  processSDKPRs,
  SECTIONS,
} = require(SDK_SCRIPT_PATH);

// --- Mock data ---
const MOCKS_DIR = path.join(__dirname, "../mocks");

function loadMock(filename: string) {
  return JSON.parse(fs.readFileSync(path.join(MOCKS_DIR, filename), "utf-8"));
}

function runGenericScript(args: string): { exitCode: number; output: string } {
  const argv = args ? args.split(/\s+/) : [];
  try {
    const output = execFileSync("node", [GENERIC_SCRIPT_PATH, ...argv], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, output };
  } catch (error) {
    const err = error as { status: number; stdout: string; stderr: string };
    return {
      exitCode: err.status || 1,
      output: (err.stdout || "") + (err.stderr || ""),
    };
  }
}

// Shared temp dir for file-generation tests, cleaned up at process exit
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-test-"));
process.on("exit", () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// Generic Script: extractVersionFromTag
// ============================================================

test("extractVersionFromTag: parses version from standard tag format", (t) => {
  const tagMock = loadMock("changelog-tags.json");
  for (const [tag, version] of Object.entries(
    tagMock.expected.versionFromTag,
  )) {
    t.is(extractVersionFromTag(tag), version);
  }
});

test("extractVersionFromTag: returns null for null input", (t) => {
  t.absent(extractVersionFromTag(null));
});

test("extractVersionFromTag: returns null for malformed tag", (t) => {
  t.absent(extractVersionFromTag("not-a-tag"));
  t.absent(extractVersionFromTag("sdk-1.0.0"));
  t.absent(extractVersionFromTag("v1.0.0"));
});

test("extractVersionFromTag: returns null for empty string", (t) => {
  t.absent(extractVersionFromTag(""));
});

// ============================================================
// Generic Script: resolveBaseRef
// ============================================================

test("resolveBaseRef: CLI override takes precedence over tag lookup", (t) => {
  t.is(resolveBaseRef("nonexistent-package", "abc123"), "abc123");
});

test("resolveBaseRef: returns null when no override and no tags", (t) => {
  t.absent(resolveBaseRef("definitely-no-tags-for-this", null));
});

// ============================================================
// Generic Script: PR number extraction (regex logic)
// ============================================================

test("getPRNumbers regex: extracts PR number from merge commit line", (t) => {
  const basicMock = loadMock("changelog-scenario-basic.json");
  const commitLines = basicMock.input.commitLog;

  for (const line of commitLines) {
    const match = line.match(/#(\d+)/);
    t.ok(match, `expected PR number in: ${line}`);
  }

  t.is(basicMock.expected.prNumbers.length, commitLines.length);
});

test("getPRNumbers regex: extracts correct PR numbers from basic scenario", (t) => {
  const basicMock = loadMock("changelog-scenario-basic.json");
  const numbers: number[] = [];

  for (const line of basicMock.input.commitLog) {
    const match = line.match(/#(\d+)/);
    if (match) numbers.push(parseInt(match[1], 10));
  }

  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  t.alike(unique, basicMock.expected.prNumbers);
});

test("getPRNumbers regex: returns empty for non-merge commits", (t) => {
  const nonMergeLines = [
    "abc1234 feat: add feature",
    "def5678 fix: resolve bug",
  ];
  const numbers: number[] = [];

  for (const line of nonMergeLines) {
    const match = line.match(/#(\d+)/);
    if (match) numbers.push(parseInt(match[1], 10));
  }

  t.is(numbers.length, 0);
});

// ============================================================
// Generic Script: generateBasicChangelog
// ============================================================

test("generateBasicChangelog: generates markdown with version header", (t) => {
  const prs = [
    {
      number: 1,
      title: "feat: add feature",
      body: "",
      url: "https://github.com/test/pull/1",
    },
  ];

  const result = generateBasicChangelog("1.0.0", prs);
  t.ok(result.includes("# Changelog v1.0.0"));
  t.ok(result.includes("## Changes"));
  t.ok(result.includes("[#1]"));
});

test("generateBasicChangelog: includes all PRs in output", (t) => {
  const prs = [
    {
      number: 1,
      title: "feat: first",
      body: "",
      url: "https://github.com/test/pull/1",
    },
    {
      number: 2,
      title: "fix: second",
      body: "",
      url: "https://github.com/test/pull/2",
    },
  ];

  const result = generateBasicChangelog("2.0.0", prs);
  t.ok(result.includes("[#1]"));
  t.ok(result.includes("[#2]"));
  t.ok(result.includes("feat: first"));
  t.ok(result.includes("fix: second"));
});

// ============================================================
// Generic Script: parseArgs
// ============================================================

test("parseArgs: parses --package flag", (t) => {
  const result = parseArgs(["--package=sdk"]);
  t.is(result.package, "sdk");
});

test("parseArgs: parses multiple flags", (t) => {
  const result = parseArgs([
    "--package=sdk",
    "--base-commit=abc123",
    "--base-version=1.0.0",
  ]);
  t.is(result.package, "sdk");
  t.is(result["base-commit"], "abc123");
  t.is(result["base-version"], "1.0.0");
});

test("parseArgs: handles --dry-run flag", (t) => {
  const result = parseArgs(["--package=test", "--dry-run="]);
  t.ok(result["dry-run"] !== undefined);
});

// ============================================================
// Generic Script: CLI integration
// ============================================================

test("generic CLI: --package flag is required", (t) => {
  const result = runGenericScript("");
  t.is(result.exitCode, 1);
  t.ok(result.output.includes("--package"));
});

// ============================================================
// SDK Wrapper: extractCodeBlocks
// ============================================================

test("extractCodeBlocks: finds all fenced code blocks", (t) => {
  const text =
    "Some text\n```ts\nconst x = 1;\n```\nMore text\n```js\nlet y = 2;\n```";
  const blocks = extractCodeBlocks(text);
  t.is(blocks.length, 2);
  t.ok(blocks[0].includes("const x = 1;"));
  t.ok(blocks[1].includes("let y = 2;"));
});

test("extractCodeBlocks: returns empty array when no code blocks", (t) => {
  const blocks = extractCodeBlocks("Just plain text here.");
  t.is(blocks.length, 0);
});

test("extractCodeBlocks: handles code blocks with language identifiers", (t) => {
  const text = "```typescript\nfunction foo() {}\n```";
  const blocks = extractCodeBlocks(text);
  t.is(blocks.length, 1);
  t.ok(blocks[0].includes("function foo()"));
});

// ============================================================
// SDK Wrapper: extractBeforeAfter
// ============================================================

test("extractBeforeAfter: finds BEFORE/AFTER markers", (t) => {
  const breakingMock = loadMock("changelog-scenario-breaking.json");
  const body = breakingMock.input.prs[0].body;
  const result = extractBeforeAfter(body);
  t.ok(result);
  t.ok(result.includes("**BEFORE:**"));
  t.ok(result.includes("**AFTER:**"));
});

test("extractBeforeAfter: finds // old // new comments in code blocks", (t) => {
  const text =
    "```ts\n// old\nconst config = setConfig({});\n\n// new\nconst config = loadConfig();\n```";
  const result = extractBeforeAfter(text);
  t.ok(result);
  t.ok(result.includes("// old"));
  t.ok(result.includes("// new"));
});

test("extractBeforeAfter: returns null when no patterns found", (t) => {
  t.absent(extractBeforeAfter("No migration examples here."));
});

// ============================================================
// SDK Wrapper: extractModelNames
// ============================================================

test("extractModelNames: extracts model names from code block", (t) => {
  const codeBlock = "```\nWHISPER_LARGE_V3\nWHISPER_MEDIUM\n```";
  t.alike(extractModelNames(codeBlock), ["WHISPER_LARGE_V3", "WHISPER_MEDIUM"]);
});

test("extractModelNames: filters out (none) markers", (t) => {
  const codeBlock = "```\n(none)\n```";
  t.is(extractModelNames(codeBlock).length, 0);
});

test("extractModelNames: filters out comments and empty lines", (t) => {
  const codeBlock = "```\n# Comment\n// Another comment\n\nWHISPER_TINY\n```";
  t.alike(extractModelNames(codeBlock), ["WHISPER_TINY"]);
});

// ============================================================
// SDK Wrapper: extractModelsSection
// ============================================================

test("extractModelsSection: extracts added models from PR body", (t) => {
  const modelsMock = loadMock("changelog-scenario-models.json");
  const body = modelsMock.input.prs[0].body;
  const result = extractModelsSection(body);

  t.ok(result);
  t.alike(result.added, modelsMock.expected.modelsAdded);
  t.alike(result.updated, modelsMock.expected.modelsUpdated);
  t.alike(result.removed, modelsMock.expected.modelsRemoved);
});

test("extractModelsSection: returns null for empty body", (t) => {
  t.absent(extractModelsSection(""));
  t.absent(extractModelsSection(null));
});

test("extractModelsSection: returns null when no Models section", (t) => {
  t.absent(extractModelsSection("## Features\nSome features."));
});

test("extractModelsSection: handles both added and removed", (t) => {
  const body =
    "## 📦 Models\n\n### Added models\n\n```\nMODEL_A\n```\n\n### Removed models\n\n```\nMODEL_B\n```";
  const result = extractModelsSection(body);
  t.ok(result);
  t.alike(result.added, ["MODEL_A"]);
  t.alike(result.updated, []);
  t.alike(result.removed, ["MODEL_B"]);
});

test("extractModelsSection: extracts updated models subsection", (t) => {
  const body =
    "## 📦 Models\n\n### Updated models\n\n```\nMODEL_X\nMODEL_Y\n```";
  const result = extractModelsSection(body);
  t.ok(result);
  t.alike(result.added, []);
  t.alike(result.updated, ["MODEL_X", "MODEL_Y"]);
  t.alike(result.removed, []);
});

test("extractModelsSection: handles added, updated, and removed together", (t) => {
  const body =
    "## 📦 Models\n\n### Added models\n\n```\nMODEL_A\n```\n\n### Updated models\n\n```\nMODEL_B\n```\n\n### Removed models\n\n```\nMODEL_C\n```";
  const result = extractModelsSection(body);
  t.ok(result);
  t.alike(result.added, ["MODEL_A"]);
  t.alike(result.updated, ["MODEL_B"]);
  t.alike(result.removed, ["MODEL_C"]);
});

// ============================================================
// SDK Wrapper: capitalize
// ============================================================

test("capitalize: capitalizes first letter", (t) => {
  t.is(capitalize("hello"), "Hello");
});

test("capitalize: handles empty string", (t) => {
  t.is(capitalize(""), "");
});

test("capitalize: handles null/undefined", (t) => {
  t.absent(capitalize(null));
  t.absent(capitalize(undefined));
});

test("capitalize: preserves already capitalized", (t) => {
  t.is(capitalize("Hello"), "Hello");
});

// ============================================================
// SDK Wrapper: generateChangelogEntry
// ============================================================

const basePR = {
  number: 123,
  url: "https://github.com/test/pull/123",
  parsed: { prefix: "feat", tags: [] as string[], subject: "add new feature" },
};

test("generateChangelogEntry: generates correct format with PR link", (t) => {
  const entry = generateChangelogEntry(basePR);
  t.ok(entry.includes("Add new feature."));
  t.ok(entry.includes("[#123]"));
  t.ok(entry.includes("[#123](https://github.com/test/pull/123)"));
});

test("generateChangelogEntry: adds breaking changes link when applicable", (t) => {
  const pr = { ...basePR, parsed: { ...basePR.parsed, tags: ["bc"] } };
  const entry = generateChangelogEntry(pr, true, false, false);
  t.ok(entry.includes("[breaking changes](./breaking.md)"));
});

test("generateChangelogEntry: adds API changes link when applicable", (t) => {
  const pr = { ...basePR, parsed: { ...basePR.parsed, tags: ["api"] } };
  const entry = generateChangelogEntry(pr, false, true, false);
  t.ok(entry.includes("[API changes](./api.md)"));
});

test("generateChangelogEntry: adds model changes link when applicable", (t) => {
  const pr = { ...basePR, parsed: { ...basePR.parsed, tags: ["mod"] } };
  const entry = generateChangelogEntry(pr, false, false, true);
  t.ok(entry.includes("[model changes](./models.md)"));
});

test("generateChangelogEntry: does not add links when detail files absent", (t) => {
  const pr = { ...basePR, parsed: { ...basePR.parsed, tags: ["bc"] } };
  const entry = generateChangelogEntry(pr, false, false, false);
  t.absent(entry.includes("See") ? true : null);
});

// ============================================================
// SDK Wrapper: processSDKPRs
// ============================================================

test("processSDKPRs: filters out invalid PR formats", (t) => {
  const prs = [
    {
      number: 1,
      title: "invalid title",
      body: "",
      url: "https://github.com/test/pull/1",
    },
    {
      number: 2,
      title: "QVAC-123 feat: valid title",
      body: "",
      url: "https://github.com/test/pull/2",
    },
  ];

  const result = processSDKPRs(prs);
  t.is(result.length, 1);
  t.is(result[0].number, 2);
});

test("processSDKPRs: filters out [skiplog] PRs", (t) => {
  const basicMock = loadMock("changelog-scenario-basic.json");
  const result = processSDKPRs(basicMock.input.prs);

  const includedNumbers = result.map((pr: any) => pr.number);
  t.alike(includedNumbers, basicMock.expected.includedInChangelog);

  for (const skippedNumber of basicMock.expected.excludedBySkiplog) {
    t.ok(
      !includedNumbers.includes(skippedNumber),
      `PR #${skippedNumber} should be excluded`,
    );
  }
});

test("processSDKPRs: attaches parsed metadata to valid PRs", (t) => {
  const prs = [
    {
      number: 10,
      title: "QVAC-50 feat[api]: add streaming",
      body: "```ts\nstream()\n```",
      url: "https://github.com/test/pull/10",
    },
  ];

  const result = processSDKPRs(prs);
  t.is(result.length, 1);
  t.is(result[0].parsed.prefix, "feat");
  t.ok(result[0].parsed.tags.includes("api"));
  t.is(result[0].parsed.subject, "add streaming");
});

// ============================================================
// SDK Wrapper: generateChangelogFiles
// ============================================================

test("generateChangelogFiles: generates CHANGELOG.md with correct sections", (t) => {
  const basicMock = loadMock("changelog-scenario-basic.json");
  const validPRs = processSDKPRs(basicMock.input.prs);
  const outDir = path.join(tmpDir, "basic");

  generateChangelogFiles("sdk", "1.0.0", validPRs, outDir);

  const changelog = fs.readFileSync(path.join(outDir, "CHANGELOG.md"), "utf-8");
  t.ok(changelog.includes("# Changelog v1.0.0"));
  t.ok(changelog.includes("## 🔌 API"));
  t.ok(changelog.includes("## 🐞 Fixes"));
  t.ok(
    !changelog.includes("update dependencies"),
    "skiplog PR should not appear",
  );
});

test("generateChangelogFiles: generates breaking.md for [bc] PRs", (t) => {
  const breakingMock = loadMock("changelog-scenario-breaking.json");
  const validPRs = processSDKPRs(breakingMock.input.prs);
  const outDir = path.join(tmpDir, "breaking");

  generateChangelogFiles("sdk", "2.0.0", validPRs, outDir);

  t.ok(fs.existsSync(path.join(outDir, "breaking.md")));
  const breakingMd = fs.readFileSync(path.join(outDir, "breaking.md"), "utf-8");
  t.ok(breakingMd.includes("💥 Breaking Changes v2.0.0"));
  t.ok(breakingMd.includes("**BEFORE:**"));
  t.ok(breakingMd.includes("**AFTER:**"));
});

test("generateChangelogFiles: generates api.md for [api] PRs", (t) => {
  const basicMock = loadMock("changelog-scenario-basic.json");
  const validPRs = processSDKPRs(basicMock.input.prs);
  const outDir = path.join(tmpDir, "api");

  generateChangelogFiles("sdk", "1.0.0", validPRs, outDir);

  t.ok(fs.existsSync(path.join(outDir, "api.md")));
  const apiMd = fs.readFileSync(path.join(outDir, "api.md"), "utf-8");
  t.ok(apiMd.includes("🔌 API Changes v1.0.0"));
  t.ok(apiMd.includes("```"));
});

test("generateChangelogFiles: generates models.md for [mod] PRs", (t) => {
  const modelsMock = loadMock("changelog-scenario-models.json");
  const validPRs = processSDKPRs(modelsMock.input.prs);
  const outDir = path.join(tmpDir, "models");

  generateChangelogFiles("sdk", "3.0.0", validPRs, outDir);

  t.ok(fs.existsSync(path.join(outDir, "models.md")));
  const modelsMd = fs.readFileSync(path.join(outDir, "models.md"), "utf-8");
  t.ok(modelsMd.includes("📦 Model Changes v3.0.0"));
  t.ok(modelsMd.includes("WHISPER_LARGE_V3"));
  t.ok(modelsMd.includes("WHISPER_MEDIUM"));
});

test("generateChangelogFiles: generates Updated Models section in models.md", (t) => {
  const prs = processSDKPRs([
    {
      number: 400,
      title: "QVAC-400 feat[mod]: update registry paths for whisper models",
      body: "## 📦 Models\n\n### Updated models\n\n```\nWHISPER_LARGE_V3\n```\n\n### Added models\n\n```\nWHISPER_TINY\n```",
      url: "https://github.com/tetherto/qvac/pull/400",
    },
  ]);
  const outDir = path.join(tmpDir, "updated-models");

  generateChangelogFiles("sdk", "4.0.0", prs, outDir);

  t.ok(fs.existsSync(path.join(outDir, "models.md")));
  const modelsMd = fs.readFileSync(path.join(outDir, "models.md"), "utf-8");
  t.ok(modelsMd.includes("📦 Model Changes v4.0.0"));
  t.ok(modelsMd.includes("## Updated Models"));
  t.ok(modelsMd.includes("WHISPER_LARGE_V3"));
  t.ok(modelsMd.includes("## Added Models"));
  t.ok(modelsMd.includes("WHISPER_TINY"));
});

test("generateChangelogFiles: does not generate detail files when not needed", (t) => {
  const prs = processSDKPRs([
    {
      number: 50,
      title: "QVAC-50 fix: simple bug fix",
      body: "Fixed a thing.",
      url: "https://github.com/test/pull/50",
    },
  ]);
  const outDir = path.join(tmpDir, "simple");

  generateChangelogFiles("sdk", "1.0.1", prs, outDir);

  t.ok(fs.existsSync(path.join(outDir, "CHANGELOG.md")));
  t.ok(!fs.existsSync(path.join(outDir, "breaking.md")));
  t.ok(!fs.existsSync(path.join(outDir, "api.md")));
  t.ok(!fs.existsSync(path.join(outDir, "models.md")));
});

// ============================================================
// SDK Wrapper: Section classification
// ============================================================

test("SECTIONS constant has expected entries", (t) => {
  const keys = SECTIONS.map((s: any) => s.key);
  t.ok(keys.includes("feat"));
  t.ok(keys.includes("api"));
  t.ok(keys.includes("fix"));
  t.ok(keys.includes("mod"));
  t.ok(keys.includes("doc"));
  t.ok(keys.includes("test"));
  t.ok(keys.includes("chore"));
  t.ok(keys.includes("infra"));
});

test("[api] tagged PRs classified into api section", (t) => {
  const basicMock = loadMock("changelog-scenario-basic.json");
  const validPRs = processSDKPRs(basicMock.input.prs);

  const apiPRs = validPRs.filter((pr: any) => pr.parsed.tags.includes("api"));
  t.is(apiPRs.length, basicMock.expected.sections.api);
});

test("[mod] tagged PRs classified into mod section", (t) => {
  const modelsMock = loadMock("changelog-scenario-models.json");
  const validPRs = processSDKPRs(modelsMock.input.prs);

  const modPRs = validPRs.filter((pr: any) => pr.parsed.tags.includes("mod"));
  t.is(modPRs.length, 1);
});
