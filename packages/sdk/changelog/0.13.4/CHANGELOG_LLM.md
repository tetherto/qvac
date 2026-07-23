# QVAC SDK v0.13.4 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.13.4

A patch release that hardens tool-call parsing for Qwen models used in agentic
workflows.

## Bug Fixes

### Recover malformed Qwen tool-call frames

Qwen3.5/3.6 can intermittently emit a malformed tool-call frame that fuses its
XML and JSON tool templates, embedding the `function=<name>` token as a bare
string key inside an otherwise JSON object. Previously the parser rejected that
frame as invalid JSON, so no structured tool call was produced and callers saw
the raw markup as assistant text. The parser now recognizes and repairs this
specific shape, so the tool call is recovered and dispatched correctly.
