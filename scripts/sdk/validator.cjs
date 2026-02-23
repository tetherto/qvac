#!/usr/bin/env node

/**
 * Unified validator for commit messages and PR titles/descriptions
 *
 * Usage:
 *   node scripts/validator.cjs --type=commit --msg="feat[api]: add new loadModel signature"
 *   node scripts/validator.cjs --type=pr --title="QVAC-123 feat[api]: add new loadModel signature" --body="..."
 */

/**
 * Single source of truth for allowed prefixes
 * To add a new prefix, just add it to this array - regex patterns are built automatically
 */
const ALLOWED_PREFIXES = ["feat", "fix", "doc", "test", "chore", "infra"];

/**
 * Single source of truth for allowed tags
 * To add a new tag, just add it to this array - regex patterns are built automatically
 *
 * Special tags:
 * - [notask]: Allows PR title to omit the ticket number (e.g., "feat[notask]: quick fix")
 * - [skiplog]: PR will be skipped by changelog generator
 * - [mod]: Model changes - requires Models section with Added/Removed subsections
 */
const ALLOWED_TAGS = ["bc", "api", "notask", "skiplog", "mod"];

/**
 * Validation exceptions - commits that should skip format validation
 * To add a new exception, just add an object with a name and test function to this array
 *
 * Example: To skip "WIP" commits, add:
 *   { name: "WIP commits", test: (message) => message.startsWith("WIP") }
 */
const VALIDATION_EXCEPTIONS = [
  {
    name: "Merge commits",
    test: (message) => message.startsWith("Merge"),
  },
  {
    name: "Version bumps",
    test: (message) => /^v?\d+\.\d+\.\d+/.test(message),
  },
  {
    name: "Revert commits",
    test: (message) => message.startsWith("Revert"),
  },
  {
    name: "Squash commits",
    test: (message) => message.startsWith("squash!"),
  },
];

/**
 * Check if a commit message should skip validation
 * @param {string} message - The commit message to check
 * @returns {boolean} True if validation should be skipped
 */
function shouldSkipValidation(message) {
  return VALIDATION_EXCEPTIONS.some((exception) => exception.test(message));
}

/**
 * Build regex patterns dynamically from ALLOWED_PREFIXES and ALLOWED_TAGS
 * This ensures the regex stays in sync with the allowed values - no manual updates needed!
 */
function buildPatterns() {
  const prefixPattern = ALLOWED_PREFIXES.join("|");

  const tagPattern = ALLOWED_TAGS.join("|");

  return {
    commit: new RegExp(`^(${prefixPattern})(\\[(${tagPattern})\\])?:\\s+(.+)`),
    // PR with ticket: "TICKET prefix[tag]: subject"
    pr: new RegExp(
      `^([A-Z]+-\\d+)\\s+(${prefixPattern})(\\[(${tagPattern})\\])?:\\s+(.+)$`,
    ),
    // PR without ticket (for [notask]): "prefix[tag]: subject"
    prNoTicket: new RegExp(
      `^(${prefixPattern})(\\[(${tagPattern})\\])?:\\s+(.+)$`,
    ),
    ticket: /^[A-Z]+-\d+$/,
  };
}

const PATTERNS = buildPatterns();
const COMMIT_PATTERN = PATTERNS.commit;
const PR_PATTERN = PATTERNS.pr;
const PR_NO_TICKET_PATTERN = PATTERNS.prNoTicket;
const TICKET_PATTERN = PATTERNS.ticket;

/**
 * Parse tags from tag string
 * @param {string} tagString - Tag string like "[breaking,api]" or "[api]"
 * @returns {string[]} Array of tags
 */
function parseTags(tagString) {
  if (!tagString) return [];
  const cleaned = tagString.replace(/[\[\]]/g, "");
  return cleaned
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Check if body contains code examples
 * @param {string} body - The PR body
 * @returns {boolean}
 */
function hasCodeBlocks(body) {
  // Check for fenced code blocks with backticks
  const fencedBlockPattern = /```[\s\S]*?```/g;
  return fencedBlockPattern.test(body);
}

/**
 * Check if body contains BEFORE/AFTER examples
 * @param {string} body - The PR body
 * @returns {boolean}
 */
function hasBeforeAfterExamples(body) {
  // Check for BEFORE: and AFTER: markers (case insensitive)
  const beforeAfterPattern = /BEFORE:\s*[\s\S]*?AFTER:/i;
  if (beforeAfterPattern.test(body)) return true;

  // Check for // old and // new style comments in code blocks
  const oldNewPattern = /\/\/\s*old[\s\S]*?\/\/\s*new/i;
  return oldNewPattern.test(body);
}

/**
 * Check if body contains valid Models section with Added and/or Removed subsections
 * At least one subsection with content must be present
 * @param {string} body - The PR body
 * @returns {{ valid: boolean, error?: string }}
 */
function hasModelsSection(body) {
  // Check for Models section header (## 📦 Models or ## Models)
  const modelsSectionPattern = /##\s*(?:📦\s*)?Models\s*\n/i;
  if (!modelsSectionPattern.test(body)) {
    return {
      valid: false,
      error: "Missing '## Models' or '## 📦 Models' section header",
    };
  }

  // Check for Added models subsection with code block
  const addedPattern = /###\s*Added\s*(?:models)?\s*\n[\s\S]*?```[\s\S]*?```/i;
  const hasAdded = addedPattern.test(body);

  // Check for Removed models subsection with code block
  const removedPattern =
    /###\s*Removed\s*(?:models)?\s*\n[\s\S]*?```[\s\S]*?```/i;
  const hasRemoved = removedPattern.test(body);

  // At least one subsection must be present
  if (!hasAdded && !hasRemoved) {
    return {
      valid: false,
      error:
        "Must include at least one subsection (### Added models or ### Removed models) with a fenced code block",
    };
  }

  return { valid: true };
}

/**
 * Validate commit message
 * @param {string} message - The commit message
 * @returns {{ valid: boolean, error?: string, parsed?: { prefix: string, tags: string[], subject: string } }}
 */
function validateCommit(message) {
  if (!message || typeof message !== "string") {
    return { valid: false, error: "Commit message is required" };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return { valid: false, error: "Commit message cannot be empty" };
  }

  // Check if this commit should skip validation (e.g., merge commits, version bumps)
  if (shouldSkipValidation(trimmed)) {
    return { valid: true };
  }

  const match = COMMIT_PATTERN.exec(trimmed);
  if (!match) {
    return {
      valid: false,
      error:
        `Invalid commit message format. Expected: prefix[tags]?: subject\n` +
        `Allowed prefixes: ${ALLOWED_PREFIXES.join(", ")}\n` +
        `Allowed tags: ${ALLOWED_TAGS.map((t) => `[${t}]`).join(", ")}\n` +
        `Example: feat[api]: add new loadModel signature`,
    };
  }

  const [, prefix, tagString, , subject] = match;
  const tags = parseTags(tagString);

  // Validate tags
  for (const tag of tags) {
    if (!ALLOWED_TAGS.includes(tag)) {
      return {
        valid: false,
        error: `Invalid tag: [${tag}]. Allowed tags: ${ALLOWED_TAGS.map((t) => `[${t}]`).join(", ")}`,
      };
    }
  }

  if (!subject || subject.trim().length === 0) {
    return { valid: false, error: "Subject cannot be empty" };
  }

  return {
    valid: true,
    parsed: {
      prefix,
      tags,
      subject: subject.trim(),
    },
  };
}

/**
 * Validate PR title and body
 * @param {string} title - The PR title
 * @param {string} body - The PR body
 * @returns {{ valid: boolean, error?: string, parsed?: { ticket: string | null, prefix: string, tags: string[], subject: string } }}
 */
function validatePR(title, body) {
  if (!title || typeof title !== "string") {
    return { valid: false, error: "PR title is required" };
  }

  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return { valid: false, error: "PR title cannot be empty" };
  }

  // Try matching with ticket first
  let match = PR_PATTERN.exec(trimmedTitle);
  let ticket = null;
  let prefix, tagString, subject;

  if (match) {
    [, ticket, prefix, tagString, , subject] = match;

    // Validate ticket format
    if (!TICKET_PATTERN.test(ticket)) {
      return {
        valid: false,
        error: `Invalid ticket format: ${ticket}. Expected format: PROJECT-123`,
      };
    }
  } else {
    // Try matching without ticket (for [notask] PRs)
    const noTicketMatch = PR_NO_TICKET_PATTERN.exec(trimmedTitle);
    if (noTicketMatch) {
      [, prefix, tagString, , subject] = noTicketMatch;
      const tempTags = parseTags(tagString);

      // Only valid without ticket if [notask] tag is present
      if (!tempTags.includes("notask")) {
        return {
          valid: false,
          error:
            `Invalid PR title format. Expected: TICKET prefix[tags]: subject\n` +
            `Allowed prefixes: ${ALLOWED_PREFIXES.join(", ")}\n` +
            `Allowed tags: ${ALLOWED_TAGS.map((t) => `[${t}]`).join(", ")}\n` +
            `Example: QVAC-123 feat[api]: add new loadModel signature\n` +
            `Note: Use [notask] tag to omit the ticket number`,
        };
      }
    } else {
      return {
        valid: false,
        error:
          `Invalid PR title format. Expected: TICKET prefix[tags]: subject\n` +
          `Allowed prefixes: ${ALLOWED_PREFIXES.join(", ")}\n` +
          `Allowed tags: ${ALLOWED_TAGS.map((t) => `[${t}]`).join(", ")}\n` +
          `Example: QVAC-123 feat[api]: add new loadModel signature\n` +
          `Note: Use [notask] tag to omit the ticket number`,
      };
    }
  }

  const tags = parseTags(tagString);

  // Validate tags
  for (const tag of tags) {
    if (!ALLOWED_TAGS.includes(tag)) {
      return {
        valid: false,
        error: `Invalid tag: [${tag}]. Allowed tags: ${ALLOWED_TAGS.map((t) => `[${t}]`).join(", ")}`,
      };
    }
  }

  // Validate subject is not empty
  if (!subject || subject.trim().length === 0) {
    return { valid: false, error: "Subject cannot be empty" };
  }

  // Validate body based on tags
  if (body && typeof body === "string") {
    const trimmedBody = body.trim();

    if (tags.includes("bc")) {
      if (!hasBeforeAfterExamples(trimmedBody)) {
        return {
          valid: false,
          error:
            `PRs with [bc] tag must include BEFORE/AFTER code examples.\n` +
            `Use either:\n` +
            `  - BEFORE: and AFTER: markers\n` +
            `  - // old and // new comments in code blocks`,
        };
      }
    }

    if (tags.includes("api") && !tags.includes("bc")) {
      if (!hasCodeBlocks(trimmedBody)) {
        return {
          valid: false,
          error:
            `PRs with [api] tag must include at least one fenced code block showing the new API usage.\n` +
            `Use triple backticks (\`\`\`) to create code blocks.`,
        };
      }
    }

    if (tags.includes("mod")) {
      const modelsResult = hasModelsSection(trimmedBody);
      if (!modelsResult.valid) {
        return {
          valid: false,
          error:
            `PRs with [mod] tag must include a Models section.\n` +
            `Required structure (at least one subsection required):\n` +
            `  ## 📦 Models\n` +
            `  ### Added models\n` +
            `  \`\`\`\n` +
            `  MODEL_CONSTANT_NAME\n` +
            `  \`\`\`\n\n` +
            `Error: ${modelsResult.error}`,
        };
      }
    }
  } else if (tags.includes("mod")) {
    // Body is required for [mod] tag
    return {
      valid: false,
      error: `PRs with [mod] tag must include a Models section in the body.`,
    };
  }

  return {
    valid: true,
    parsed: {
      ticket,
      prefix,
      tags,
      subject: subject.trim(),
    },
  };
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage:");
    console.error('  node scripts/validator.js --type=commit --msg="..."');
    console.error(
      '  node scripts/validator.js --type=pr --title="..." --body="..."',
    );
    process.exit(1);
  }

  const params = {};
  for (const arg of args) {
    const [key, ...valueParts] = arg.split("=");
    const value = valueParts.join("=");
    params[key.replace(/^--/, "")] = value;
  }

  if (params.type === "commit") {
    if (!params.msg) {
      console.error("Error: --msg is required for commit validation");
      process.exit(1);
    }

    const result = validateCommit(params.msg);
    if (!result.valid) {
      console.error("❌ Invalid commit message:");
      console.error(result.error);
      process.exit(1);
    }

    console.log("✅ Valid commit message");
    console.log("Parsed:", JSON.stringify(result.parsed, null, 2));
    process.exit(0);
  } else if (params.type === "pr") {
    if (!params.title) {
      console.error("Error: --title is required for PR validation");
      process.exit(1);
    }

    const result = validatePR(params.title, params.body || "");
    if (!result.valid) {
      console.error("❌ Invalid PR:");
      console.error(result.error);
      process.exit(1);
    }

    console.log("✅ Valid PR");
    console.log("Parsed:", JSON.stringify(result.parsed, null, 2));
    process.exit(0);
  } else {
    console.error(
      `Error: Invalid type "${params.type}". Must be "commit" or "pr"`,
    );
    process.exit(1);
  }
}

// Export for use as module
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    validateCommit,
    validatePR,
    hasModelsSection,
    ALLOWED_PREFIXES,
    ALLOWED_TAGS,
  };
}

// Run CLI if executed directly
if (require.main === module) {
  main();
}
