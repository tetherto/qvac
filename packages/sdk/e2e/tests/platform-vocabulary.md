# Platform vocabulary

`skip.platforms` names the platforms a test does **not** apply to. The names
below are the vocabulary; they land in every definition that carries a skip,
which is why they are written down before the catalog starts using them and
why adding one later is expensive.

## The names

| Name | Leg |
| --- | --- |
| `desktop-macos`, `desktop-linux`, `desktop-windows` | desktop Node |
| `electron-macos`, `electron-linux`, `electron-windows` | packaged Electron app |
| `snap-linux` | strict-confined Snap |
| `mobile-ios`, `mobile-android` | the mobile app |
| `<client>-desktop-<os>` | a non-JS client, e.g. `python-desktop-macos` |

The OS is part of the name because such skips already exist in practice: OCR
is off on iOS for ONNX/CoreML OOM, parakeet streaming is off on Android as
flaky. A vocabulary that could not say "iOS but not Android" would force those
back into consumer code, which is exactly what this moves away from.

## Matching

A leg registers with a label. A skip entry applies when it **equals** the
label, or is a **segment prefix** of it:

| catalog entry | leg | applies |
| --- | --- | --- |
| `mobile-ios` | `mobile-ios` | yes — exact |
| `desktop` | `desktop-macos` | yes — coarse entry, specific leg |
| `desktop-macos` | `desktop-linux` | no — different OS |
| `desktop` | `desktopish-thing` | no — segments, not string prefix |

The coarse case is what makes the move safe: the catalog can keep saying
`desktop` while the legs start registering as `desktop-macos`, and nothing
changes about what runs. The two can then be reconciled test by test instead
of in one commit.

Segment matching, rather than `startsWith`, is deliberate — otherwise a new
consumer whose name happens to begin with an existing one would silently
inherit its skips.

## Equivalence

Moving platform policy into the catalog must not change what any leg runs.
The rule above was checked against every definition × every label a leg
registers with today:

```
decisions checked: 3156 | differences: 0
```

That is the cheap half of the gate and it holds. The other half cannot be
checked on a laptop: the real per-leg counts have to be recorded from an
actual run of all five legs before the move and required identical after.
Snap needs Linux, and the mobile legs need devices — so that half runs in CI.
