# Framework Validation

This directory mimics a real target repository using the QVAC test framework.

## Structure

- `package.json` - Dependencies (like a real repo)
- `qvac-test.config.js` - Framework configuration
- `tests/` - Test definitions and executors
- `step-N-*.md` - Validation instructions per step
- `build/` - Built consumer packages (generated)

## Usage

Each step has validation instructions:

```bash
# Step 1: Config loading
node step-1-config-loading.js

# Step 2-5: See step-N-*.md files for instructions
```

## Purpose

Validates framework functionality by acting as a real target repo would.

## Cleanup

This directory can be deleted after MVP is complete. It's only for framework development validation.
