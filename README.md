# Visual Review Pages

Static visual review app for reg-viz/reg-actions screenshot reports.

This repository is the reusable source for the GitHub Pages review UI used by
Mission Control PR visual reports. The app is intentionally framework-free so a
CI publisher can copy `src/visual-review-app.css`, `src/visual-review-app.js`,
an `index.html` shell, and the report-local `__reg__` image tree into any Pages
directory.

## Reviewer Features

- Review queue for changed, new, deleted, and unchanged snapshots.
- Search and group filters for large PR screenshot sets.
- Side-by-side, highlighter, overlay, and blink views for changed snapshots.
- Local approve/reject marks with a copyable PR review summary.
- Links back to the raw reg-viz report, workflow run, and pull request.

Review marks are stored only in browser `localStorage`. The authoritative
approval or request-changes decision still belongs in the GitHub PR review.

## Producer Contract

See `docs/producer-contract.md` for the required inline JSON shape and static
file layout.

## Validation

```bash
node --check src/visual-review-app.js
```
