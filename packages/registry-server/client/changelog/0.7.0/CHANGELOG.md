# Changelog v0.7.0

Release Date: 2026-09-18

## ✨ Features

- `QVACModelEntry` exposes the optional `fitBlobBinding`, a pointer to a weightless description of the artifact — the tensor list without the weights — addressed with `downloadBlob` like the model itself (#4445).

## 🔧 Changed

- `QVACBlobBinding` declares `sha256`, which the schema has always carried and the typing omitted.
- Bump `@qvac/registry-schema` from `^0.3.0` to `^0.4.0`.
