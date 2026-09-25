# Platform vocabulary

`skip.platforms` names the platforms a test does **not** apply to. These names
land in every definition that carries a skip, which is why adding one is
expensive: it has to mean the same thing on every client.

## The names

| Name | Leg |
| --- | --- |
| `desktop-macos`, `desktop-linux`, `desktop-windows` | desktop Node |
| `electron-macos`, `electron-linux`, `electron-windows` | packaged Electron app |
| `snap-linux` | strict-confined Snap |
| `mobile-ios`, `mobile-android` | the mobile app |
| `desktop-python` | the Python client on desktop |

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

The coarse case is what keeps the two reconcilable test by test: a catalog
entry of `desktop` goes on matching a leg that registers as `desktop-macos`,
so narrowing a rule is a one-line change rather than a sweep.

Segment matching, rather than `startsWith`, is deliberate — otherwise a new
consumer whose name happens to begin with an existing one would silently
inherit its skips.

## Equivalence

Moving platform policy into the catalog must not change what any leg runs.
The rule above was checked against every definition times every label a leg
registers with today, and no decision changed.
