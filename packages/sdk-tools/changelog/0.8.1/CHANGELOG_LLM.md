# QVAC CLI v0.8.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.8.1

This is a maintenance release. It fixes a diagnostics gap in the OpenAI-compatible server, corrects a documentation claim about Vulkan GPU fallback behavior, and moves the CLI onto `@qvac/sdk` 0.15.0.

## Other Changes

Server errors are now logged with their full stack trace when a request handler throws, making failures easier to diagnose from server logs rather than only the client-facing error response. The Vulkan backend documentation now states the correct minimum required Vulkan version (1.4) and removes an inaccurate claim about CPU fallback behavior. The CLI's committed `@qvac/sdk` dependency now targets `^0.15.0`. Lint, format, and typecheck tooling was also unified across SDK-pod packages with Prettier, with no user-facing effect.
