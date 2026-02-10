# Changelog

## 0.2.0

### Features

- Add `findBy()` method to `RegistryDatabase` for unified model querying with optional filters (`name`, `engine`, `quantization`, `includeDeprecated`)
- Add `findModelsByEngineQuantization()` method for compound index queries
- Add `models-by-engine-quantization` compound HyperDB index for efficient multi-field lookups

### Notes

- The `findBy()` method intelligently routes to the most efficient HyperDB index based on the provided parameters
- Compound index follows B-tree leftmost prefix matching: queries by `engine` alone or `engine + quantization` use the index natively; other combinations use in-memory filtering
- Existing `findModels*` methods remain unchanged

## 0.1.0

- Initial release
