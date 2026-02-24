# Contributing to qvac-lib-infer-parakeet

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what is best for the community

## How to Contribute

### Reporting Bugs

1. **Check existing issues** to avoid duplicates
2. **Use the issue template** when creating a new issue
3. **Include**:
   - Clear description of the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Bare version, model used)
   - Error messages and logs

### Suggesting Features

1. **Open a discussion** first for major features
2. **Explain the use case** and benefits
3. **Consider alternatives** and trade-offs

### Pull Requests

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes**:
   - Follow the code style guidelines
   - Add tests for new functionality
   - Update documentation
4. **Commit with clear messages**:
   ```
   Add support for new model variant
   
   - Implement FOO model type
   - Add tests for FOO
   - Update documentation
   ```
5. **Push to your fork**
6. **Open a Pull Request**

### Code Style

#### C++ Code

- **Standard**: C++20
- **Formatting**: Run `clang-format` before committing
  ```bash
  find src -name "*.cpp" -o -name "*.hpp" | xargs clang-format -i
  ```
- **Naming conventions**:
  - Classes: `PascalCase`
  - Functions: `camelCase`
  - Variables: `snake_case`
  - Constants: `UPPER_CASE`
  - Private members: `trailing_`

#### JavaScript Code

- **Standard**: ES6+
- **Style**: 2-space indentation
- **Naming**: camelCase for variables and functions

### Testing

- **Write tests** for new features
- **Run existing tests** before submitting:
  ```bash
  cmake -S . -B build -DBUILD_TESTING=ON
  cmake --build build
  ctest --test-dir build
  ```
- **Test on multiple platforms** if possible

### Documentation

- **Update README.md** for user-facing changes
- **Update DEVELOPMENT.md** for developer-facing changes
- **Add JSDoc comments** for JavaScript APIs
- **Add Doxygen comments** for C++ APIs

## Development Setup

See [DEVELOPMENT.md](DEVELOPMENT.md) for detailed setup instructions.

Quick setup:

```bash
# Clone your fork
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/qvac-lib-infer-parakeet

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Areas for Contribution

We welcome contributions in these areas:

### High Priority

- [ ] Implement proper audio preprocessing (mel-spectrograms)
- [ ] Add streaming support for long audio files
- [ ] Implement beam search decoding
- [ ] Add more comprehensive tests
- [ ] Improve error messages and logging
- [ ] Performance optimizations

### Medium Priority

- [ ] Support for more audio formats
- [ ] Batch processing support
- [ ] Real-time streaming with EOU model
- [ ] Integration examples (React Native, Electron)
- [ ] Benchmarking suite
- [ ] CI/CD pipeline

### Good First Issues

- [ ] Add more examples
- [ ] Improve documentation
- [ ] Fix typos
- [ ] Add JSDoc comments
- [ ] Create integration tests

## Questions?

- 💬 Open a [discussion](https://github.com/tetherto/qvac/discussions)
- 📧 Contact the maintainers

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 License.

