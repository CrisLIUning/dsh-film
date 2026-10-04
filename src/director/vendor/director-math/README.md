# director-math (vendored)

The director desk's pure scene math (schema/**, the mannequin body types and
pose, the UE4 mannequin body metrics), copied unchanged from
[vibedev-director-desk](https://github.com/CrisLIUning/vibedev-director-desk)
`src/editor` (MIT, Copyright (c) 2026 YZ — see `LICENSE`). The copy is the one
Studio vendors with its `scripts/sync-director-math.ts`: the only rewrite is
relative imports gaining `.js` for NodeNext resolution, plus the `@ts-nocheck`
banner (the desk type-checks these files under its own tsconfig).

Do not edit here: change the desk, re-run Studio's sync script, and copy the
result and `../director-math.manifest.json` over. The manifest pins the source
commit and the hash of every file; `tests/director/math-vendor.spec.ts` fails if
either drifts and recomputes the desk's golden samples.
