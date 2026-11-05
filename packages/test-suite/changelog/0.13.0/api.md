# 🔌 API Changes v0.13.0

## Mqtt-mode external consumers, a prepare step and run:local:<name>

PR: [#5357](https://github.com/tetherto/qvac/pull/5357)

```js
// qvac-test.config.js → consumers.external
{
  name: 'kotlin-android',
  platform: 'kotlin-android',
  mode: 'mqtt',
  prepare: { interpreter: 'node', args: ['runners/kotlin/scripts/device.mjs', 'prepare'] },
  interpreter: 'node',
  args: ['runners/kotlin/scripts/device.mjs', 'run']
}
```

```bash
npx qvac-test run:local:kotlin-android   # = run:local:external --name=kotlin-android
```

---

