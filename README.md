# chat-vm-mame-runtime

Public runtime assets for running a FreeDOS + DOS MAME 0.37b14 virtual machine in a ChatGPT HTML Preview.

## Scope

This repository is intentionally separate from `ai-game-studio-os`.

It stores only:

- a pinned JavaScript-only v86 runtime (`runtime/v86_all.js`)
- the unmodified official DOS MAME 0.37b14 binary archive (`mame/m37b14b.zip`)
- source, license, checksum, and provenance records
- Preview integration code added after runtime validation

It does **not** store commercial arcade ROMs, private user files, or AI Game Studio OS sources.

## Automated asset sync

`.github/workflows/sync-runtime.yml` runs on its initial commit or by manual dispatch. It:

1. downloads the pinned `v86-wasmless` runtime
2. downloads the original DOS MAME 0.37b14 archive from known public mirrors
3. rejects HTML/error responses and invalid ZIP files
4. confirms that the archive contains `MAME.EXE`
5. generates `manifest.json` with file sizes and SHA-256 hashes
6. commits only verified assets back to `main`

Expected generated files:

```text
runtime/v86_all.js
mame/m37b14b.zip
notices/V86-LICENSE.txt
notices/MAME-0.37b14-README.txt
manifest.json
```

## ROM policy

MAME requires ROM images supplied by a legally entitled user. Commercial ROM sets are not bundled here.

Robby Roto is handled separately from the runtime and should be loaded only from the official MAMEdev distribution path under its stated non-commercial-use terms:

- https://www.mamedev.org/roms/robby/

## Upstream sources

- v86-wasmless: https://github.com/Pixelsuft/v86-wasmless
- MAME previous releases: https://www.mamedev.org/oldrel.html
- MAME 0.37b14 source: https://github.com/mamedev/historic-mame/tree/mame037b14

## Status

Runtime sync is considered complete only after `manifest.json`, `runtime/v86_all.js`, and `mame/m37b14b.zip` are present on `main` and their checksums are recorded.
