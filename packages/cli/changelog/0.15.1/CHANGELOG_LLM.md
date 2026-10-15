# QVAC CLI v0.15.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.15.1

## Bug Fixes

### Translate batch cap

With zod 4.6.6 and later, a `qvac translate` request whose text array is over the input cap returned `missing_text`. It returns `too_many_inputs` again.
