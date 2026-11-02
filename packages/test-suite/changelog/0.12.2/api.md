# 🔌 API Changes v0.12.2

## Report only this leg's reasons for a merged platform skip

PR: [#5048](https://github.com/tetherto/qvac/pull/5048)

```typescript
const skip: SkipInfo = {
  reason: 'electron, snap: too slow for the packaged pass | mobile: OOM on device',
  platforms: ['electron', 'snap', 'mobile'],
  reasons: [
    { platforms: ['electron', 'snap'], reason: 'too slow for the packaged pass' },
    { platforms: ['mobile'], reason: 'OOM on device' }
  ]
}
// mobile-android leg reports: "OOM on device"
```

---

