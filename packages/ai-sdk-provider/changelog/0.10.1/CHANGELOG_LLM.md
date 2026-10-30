# QVAC AI SDK Provider v0.10.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.10.1

This patch moves the provider onto `@qvac/cli` 0.17 and raises its AI SDK dependency floors. Provider behavior is unchanged.

## Dependency Alignment

The optional `@qvac/cli` peer is now `^0.17.0`. A 0.x caret range does not cross a minor, so `^0.16.0` would not accept CLI 0.17.

`@ai-sdk/provider` now needs `^4.0.10` and `@ai-sdk/provider-utils` `^5.0.35`. Older versions lack the `FilesV4` stream types the provider builds against, so an install that resolved them could fail to type-check.
