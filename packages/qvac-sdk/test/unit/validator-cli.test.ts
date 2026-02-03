// @ts-nocheck - test files are excluded from tsconfig
import { describe, test, expect, beforeAll } from "bun:test";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const VALIDATOR_PATH = path.join(__dirname, "../../scripts/validator.cjs");
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
  // Escape for shell: replace single quotes and wrap in single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

describe("Validator CLI", () => {
  beforeAll(() => {
    // Verify mocks directory exists
    expect(fs.existsSync(MOCKS_DIR)).toBe(true);
  });

  describe("Commit Message Validation", () => {
    describe("Valid commit messages", () => {
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
        {
          msg: "chore[skiplog]: internal cleanup",
          desc: "chore with skiplog tag",
        },
      ];

      for (const { msg, desc } of validMessages) {
        test(`accepts ${desc}: "${msg}"`, () => {
          const result = runValidator(`--type=commit --msg="${msg}"`);
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain("✅ Valid commit message");
        });
      }
    });

    describe("Invalid commit messages", () => {
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
        test(`rejects ${desc}: "${msg}"`, () => {
          const result = runValidator(`--type=commit --msg="${msg}"`);
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain("❌ Invalid commit message");
        });
      }
    });

    describe("Auto-skipped commit messages", () => {
      const skippedMessages = [
        { msg: "Merge pull request #123", desc: "merge commit" },
        { msg: "Merge branch 'dev' into main", desc: "merge branch" },
        { msg: "1.0.0", desc: "version bump" },
        { msg: "v2.3.4", desc: "version bump with v prefix" },
        { msg: 'Revert "feat: add feature"', desc: "revert commit" },
        { msg: "squash! fix: bug fix", desc: "squash commit" },
      ];

      for (const { msg, desc } of skippedMessages) {
        test(`skips validation for ${desc}: "${msg}"`, () => {
          const result = runValidator(`--type=commit --msg="${msg}"`);
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain("✅ Valid commit message");
        });
      }
    });
  });

  describe("PR Title Validation", () => {
    describe("Valid PR titles", () => {
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
        test(`accepts ${desc}: "${title}"`, () => {
          const body = loadMock(bodyFile);
          const result = runValidator(
            `--type=pr --title="${title}" --body=${escapeShellArg(body)}`,
          );
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain("✅ Valid PR");
        });
      }
    });

    describe("Invalid PR titles", () => {
      const invalidTitles = [
        { title: "feat: missing ticket", desc: "missing ticket" },
        { title: "QVAC feat: missing dash", desc: "malformed ticket" },
        { title: "123 feat: numeric only ticket", desc: "no project prefix" },
        { title: "QVAC-123 mod: models update", desc: "mod as prefix" },
        { title: "QVAC-123: missing prefix", desc: "missing prefix" },
        { title: "QVAC-123 FEAT: uppercase", desc: "uppercase prefix" },
      ];

      for (const { title, desc } of invalidTitles) {
        test(`rejects ${desc}: "${title}"`, () => {
          const body = loadMock("pr-body-simple.md");
          const result = runValidator(
            `--type=pr --title="${title}" --body=${escapeShellArg(body)}`,
          );
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain("❌ Invalid PR");
        });
      }
    });
  });

  describe("PR Body Validation - [bc] tag", () => {
    test("accepts PR with valid BEFORE/AFTER markers", () => {
      const body = loadMock("pr-body-bc-valid.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[bc]: breaking change" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("✅ Valid PR");
    });

    test("accepts PR with valid inline old/new comments", () => {
      const body = loadMock("pr-body-bc-valid-inline.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[bc]: breaking change" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("✅ Valid PR");
    });

    test("rejects PR without BEFORE/AFTER examples", () => {
      const body = loadMock("pr-body-bc-invalid.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[bc]: breaking change" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("BEFORE/AFTER");
    });
  });

  describe("PR Body Validation - [api] tag", () => {
    test("accepts PR with code blocks", () => {
      const body = loadMock("pr-body-api-valid.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[api]: add api" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("✅ Valid PR");
    });

    test("rejects PR without code blocks", () => {
      const body = loadMock("pr-body-api-invalid.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[api]: add api" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("fenced code block");
    });
  });

  describe("PR Body Validation - [mod] tag", () => {
    test("accepts PR with only Added models section", () => {
      const body = loadMock("pr-body-mod-valid-added.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[mod]: add models" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("✅ Valid PR");
    });

    test("accepts PR with only Removed models section", () => {
      const body = loadMock("pr-body-mod-valid-removed.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[mod]: remove models" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("✅ Valid PR");
    });

    test("accepts PR with both Added and Removed sections", () => {
      const body = loadMock("pr-body-mod-valid-both.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[mod]: update models" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("✅ Valid PR");
    });

    test("rejects PR without Models section", () => {
      const body = loadMock("pr-body-mod-invalid-no-section.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[mod]: add models" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Models section");
    });

    test("rejects PR with Models section but no code blocks", () => {
      const body = loadMock("pr-body-mod-invalid-no-codeblock.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[mod]: add models" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("subsection");
    });

    test("rejects PR with [mod] tag and empty body", () => {
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat[mod]: add models" --body=""`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Models section");
    });
  });

  describe("Edge Cases", () => {
    test("handles missing --msg argument for commit", () => {
      const result = runValidator("--type=commit");
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("--msg is required");
    });

    test("handles missing --title argument for PR", () => {
      const result = runValidator("--type=pr");
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("--title is required");
    });

    test("handles invalid type argument", () => {
      const result = runValidator("--type=invalid");
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid type");
    });

    test("handles no arguments", () => {
      const result = runValidator("");
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Usage");
    });

    test("PR without body passes for non-special tags", () => {
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat: add feature" --body=""`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("✅ Valid PR");
    });

    test("commit message with special characters", () => {
      const result = runValidator(
        `--type=commit --msg="feat: add support for 'quotes' and \\"escapes\\""`,
      );
      expect(result.exitCode).toBe(0);
    });

    test("PR title with special characters in subject", () => {
      const body = loadMock("pr-body-simple.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 feat: add (parens) and dashes-here" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Parsed Output Verification", () => {
    test("commit returns correct parsed structure", () => {
      const result = runValidator(
        `--type=commit --msg="feat[api]: add streaming support"`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('"prefix": "feat"');
      expect(result.output).toContain('"tags"');
      expect(result.output).toContain('"api"');
      expect(result.output).toContain('"subject": "add streaming support"');
    });

    test("PR returns correct parsed structure with ticket", () => {
      const body = loadMock("pr-body-bc-valid.md");
      const result = runValidator(
        `--type=pr --title="QVAC-123 fix[bc]: breaking change" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('"ticket": "QVAC-123"');
      expect(result.output).toContain('"prefix": "fix"');
      expect(result.output).toContain('"bc"');
    });

    test("PR with [notask] returns null ticket", () => {
      const body = loadMock("pr-body-simple.md");
      const result = runValidator(
        `--type=pr --title="feat[notask]: quick fix" --body=${escapeShellArg(body)}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('"ticket": null');
    });
  });
});
