# QVAC CLI v0.7.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.7.1

A patch release that pulls in the `@qvac/sdk` 0.13.4 tool-call parsing fix so the
OpenAI-compatible server recovers malformed Qwen tool-call frames.

## Bug Fixes

### Recover malformed Qwen tool-call frames

`qvac serve` delegates tool-call parsing to `@qvac/sdk`. Qwen3.5/3.6 can
intermittently emit a malformed tool-call frame that fuses its XML and JSON tool
templates, embedding the `function=<name>` token as a bare string key inside an
otherwise JSON object. The SDK previously rejected that frame as invalid JSON, so
no structured tool call was produced and callers saw the raw markup as assistant
text. This release raises the `@qvac/sdk` floor to `^0.13.4`, which recognizes and
repairs that specific shape so the tool call is recovered and dispatched correctly.
