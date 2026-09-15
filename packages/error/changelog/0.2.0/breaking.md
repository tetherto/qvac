# 💥 Breaking Changes v0.2.0

## Convert @qvac/error to TypeScript ESM

PR: [#3720](https://github.com/tetherto/qvac/pull/3720)

**BEFORE:**

```js
const { QvacErrorBase } = require('@qvac/error')
```

**AFTER:**

```ts
import { QvacErrorBase } from '@qvac/error'
```

---
