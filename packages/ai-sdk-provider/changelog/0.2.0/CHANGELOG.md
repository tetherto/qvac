# Changelog v0.2.0

## Added

- Add managed mode to `@qvac/ai-sdk-provider`, allowing `createQvac({ mode: 'managed', models })` to synthesize a temporary `qvac serve` config, spawn or reuse a shared serve, and clean it up once no consumers remain.
- Add the public managed-mode option and type surface: `ManagedQvacProvider`, `QvacManagedOptions`, `QvacManagedModel`, `QvacExternalOptions`, managed setup errors, serve reuse controls, idle timeout controls, and optional `@qvac/cli` peer dependency resolution.
- Add a friendly model catalog that maps public model ids such as `qwen3.5-9b` to SDK model constants for managed configs and models.dev-aligned integrations.

## Notes

- External mode is unchanged and remains the default synchronous provider path.
- Managed mode is loaded only when `mode: 'managed'` is used.
