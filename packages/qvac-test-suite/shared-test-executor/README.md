# Shared Test Executor

Shared test execution logic between desktop and mobile test consumers.

## Structure

- `test-executor-base.ts` - Base class with all ~100 test handler methods

## Pattern

```typescript
export abstract class TestExecutorBase {
  constructor(sdk: SDKFunctions, platform: PlatformFunctions) {
    // Inject SDK and platform-specific functions
  }
  
  // Platform-specific methods to implement
  protected abstract readDocumentFile(filename: string, category: 'documents' | 'code'): Promise<string>;
  protected abstract getAudioFilePath(filename: string): Promise<string>;
}
```

## Platform Implementations

**Desktop:**
- Uses `fs.readFileSync()` for file reading
- Direct file paths via `path.join()`

**Mobile:**
- Uses `expo-asset` + `expo-file-system` for asset loading
- Static asset manifest (`shared-test-data/assets.js`) with `require()` for Metro bundling
- Assets downloaded via `Asset.fromModule().downloadAsync()`

## Shared Test Data

All test assets (audio, documents, code) live in `shared-test-data/`.

Run `node shared-test-data/generate-assets.cjs` to regenerate the asset manifest when files are added/removed.

## Benefits

- **3,300 lines** of duplication eliminated
- Single place to update test logic
- Consistent behavior across platforms
- Easy to maintain and extend
